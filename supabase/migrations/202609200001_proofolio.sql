-- Run once in Supabase SQL Editor. No existing data is removed.
-- Browser roles have NO access. Only the trusted Next.js server / SQL Editor writes.
begin;

create table public.proofolio_users (
  id text primary key check (id ~ '^[a-f0-9]{64}$'), -- SHA-256 of secret guest cookie, never the cookie itself
  auth_user_id uuid references auth. users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index proofolio_users_auth_idx on public.proofolio_users(auth_user_id) where auth_user_id is not null;

create table public.proofolio_runs (
  id uuid primary key,
  user_id text not null references public.proofolio_users(id),
  track text not null check (track in ('design', 'marketing')),
  file_name text not null,
  pdf_sha256 text not null check (pdf_sha256 ~ '^[a-f0-9]{64}$'),
  requested_question_count smallint not null check (requested_question_count between 1 and 10),
  state text not null check (state in ('queued', 'running', 'complete', 'failed')),
  started_at timestamptz not null,
  finished_at timestamptz,
  error text,
  result jsonb, -- original client result incl. quality status; never PDF/raw model responses
  metrics jsonb,
  schema_version text,
  generated_question_count integer generated always as (coalesce(jsonb_array_length(result->'questions'), 0)) stored,
  constraint proofolio_result_state check (
    (state = 'complete' and result is not null and coalesce(jsonb_typeof(result->'questions') = 'array', false)) or
    (state <> 'complete' and result is null)
  ),
  check (generated_question_count <= requested_question_count)
);
create index proofolio_runs_user_created_idx on public.proofolio_runs(user_id, started_at desc);
create index proofolio_runs_created_idx on public.proofolio_runs(started_at desc);

create table public.proofolio_questions (
  run_id uuid not null references public.proofolio_runs(id),
  question_id text not null check (length(question_id) between 1 and 100),
  position smallint not null check (position between 1 and 10),
  card jsonb not null check (coalesce(jsonb_typeof(card) = 'object' and card->>'id' = question_id and
    jsonb_typeof(card->'prompt') = 'string', false)), -- prompt, quotes, pages, intent, listenFor, answerTarget
  primary key (run_id, question_id),
  unique (run_id, position)
);

create table public.proofolio_answers (
  run_id uuid not null,
  question_id text not null,
  answer text not null check (char_length(answer) <= 500),
  seconds bigint not null check (seconds between 0 and 9007199254740991),
  saved_at timestamptz not null default now(),
  primary key (run_id, question_id),
  foreign key (run_id, question_id) references public.proofolio_questions(run_id, question_id)
);

alter table public.proofolio_users enable row level security;
alter table public.proofolio_runs enable row level security;
alter table public.proofolio_questions enable row level security;
alter table public.proofolio_answers enable row level security;
revoke all on public.proofolio_users, public.proofolio_runs, public.proofolio_questions, public.proofolio_answers from public, anon, authenticated, service_role;
grant select, insert, update on public.proofolio_users, public.proofolio_runs to service_role;
grant select, insert on public.proofolio_questions, public.proofolio_answers to service_role;

-- Run + all generated cards are published atomically. Completed results are immutable.
create function public.proofolio_sync_run(p_run jsonb) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  r public.proofolio_runs;
  result_value jsonb := nullif(p_run->'result', 'null'::jsonb);
  metrics_value jsonb := nullif(p_run->'metrics', 'null'::jsonb);
begin
  insert into public.proofolio_users(id) values (p_run->>'user_id') on conflict (id) do nothing;
  insert into public.proofolio_runs(id, user_id, track, file_name, pdf_sha256, requested_question_count, state, started_at)
  values ((p_run->>'id')::uuid, p_run->>'user_id', p_run->>'track', p_run->>'file_name', p_run->>'pdf_sha256',
    (p_run->>'requested_question_count')::smallint, 'queued', (p_run->>'started_at')::timestamptz)
  on conflict (id) do nothing;
  select * into strict r from public.proofolio_runs where id = (p_run->>'id')::uuid for update;
  if r.user_id is distinct from p_run->>'user_id' or r.pdf_sha256 is distinct from p_run->>'pdf_sha256'
    or r.track is distinct from p_run->>'track' or r.file_name is distinct from p_run->>'file_name'
    or r.requested_question_count is distinct from (p_run->>'requested_question_count')::smallint
    or r.started_at is distinct from (p_run->>'started_at')::timestamptz then
    raise exception 'Run identity conflict' using errcode = '23505';
  end if;
  if r.state in ('complete', 'failed') and (r.state is distinct from p_run->>'state'
    or r.result is distinct from result_value or r.metrics is distinct from metrics_value
    or r.error is distinct from p_run->>'error' or r.finished_at is distinct from (p_run->>'finished_at')::timestamptz
    or r.schema_version is distinct from p_run->>'schema_version') then
    raise exception 'Completed run is immutable' using errcode = '23505';
  end if;
  update public.proofolio_runs set state = p_run->>'state', finished_at = (p_run->>'finished_at')::timestamptz,
    error = p_run->>'error', result = result_value, metrics = metrics_value, schema_version = p_run->>'schema_version'
    where id = r.id;
  insert into public.proofolio_questions(run_id, question_id, position, card)
    select r.id, value->>'id', ordinality::smallint, value
    from jsonb_array_elements(result_value->'questions') with ordinality
    on conflict (run_id, question_id) do nothing;
  if (select count(*) from public.proofolio_questions where run_id = r.id) <> coalesce(jsonb_array_length(result_value->'questions'), 0) then
    raise exception 'Question IDs must be unique' using errcode = '22023';
  end if;
  return r.id;
end;
$$;

-- Whole submission, not individual overwrites. The row lock makes concurrent retries safe.
create function public.proofolio_save_answers(p_run_id uuid, p_user_id text, p_answers jsonb) returns integer
language plpgsql security invoker set search_path = '' as $$
declare
  r public.proofolio_runs;
  item jsonb;
  existing public.proofolio_answers;
begin
  select * into r from public.proofolio_runs where id = p_run_id and user_id = p_user_id for update;
  if not found or r.state <> 'complete' or r.generated_question_count = 0 then
    raise exception 'Completed owned run required' using errcode = '22023';
  end if;
  if jsonb_typeof(p_answers) is distinct from 'array' then
    raise exception 'Answers array required' using errcode = '22023';
  end if;
  if jsonb_array_length(p_answers) <> r.generated_question_count or
    (select count(distinct value->>'questionId') from jsonb_array_elements(p_answers)) <> r.generated_question_count then
    raise exception 'Answer count or duplicate IDs' using errcode = '22023';
  end if;
  for item in select value from jsonb_array_elements(p_answers) loop
    if jsonb_typeof(item) is distinct from 'object' then
      raise exception 'Answer object required' using errcode = '22023';
    end if;
    if (select count(*) from jsonb_object_keys(item)) <> 3 or
      jsonb_typeof(item->'questionId') is distinct from 'string' or
      jsonb_typeof(item->'answer') is distinct from 'string' or
      jsonb_typeof(item->'seconds') is distinct from 'number' or
      (item->>'seconds') !~ '^[0-9]+$' or
      not exists (select 1 from public.proofolio_questions where run_id = r.id and question_id = item->>'questionId') then
      raise exception 'Invalid answer fields' using errcode = '22023';
    end if;
    select * into existing from public.proofolio_answers where run_id = r.id and question_id = item->>'questionId';
    if found then
      if existing.answer is distinct from item->>'answer' or existing.seconds is distinct from (item->>'seconds')::bigint then
        raise exception 'Saved answer is immutable' using errcode = '23505';
      end if;
    else
      insert into public.proofolio_answers(run_id, question_id, answer, seconds)
      values (r.id, item->>'questionId', item->>'answer', (item->>'seconds')::bigint);
    end if;
  end loop;
  return r.generated_question_count;
end;
$$;
revoke all on function public.proofolio_sync_run(jsonb) from public, anon, authenticated;
revoke all on function public.proofolio_save_answers(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.proofolio_sync_run(jsonb), public.proofolio_save_answers(uuid, text, jsonb) to service_role;

-- Dashboard-ready, read-only projections. Never grant these to browser roles.
create view public.proofolio_admin_runs with (security_invoker = true) as
select r.id as run_id, r.user_id, u.auth_user_id, r.track, r.file_name, r.pdf_sha256,
  r.state, r.started_at, r.finished_at, r.requested_question_count, r.generated_question_count,
  r.result->>'status' as analysis_status, r.result->'qualityIssues' as quality_issues, r.metrics, r.error,
  (select count(*) from public.proofolio_answers a where a.run_id = r.id) as submitted_count,
  (select count(*) from public.proofolio_answers a where a.run_id = r.id and btrim(a.answer) <> '') as answered_count
from public.proofolio_runs r join public.proofolio_users u on u.id = r.user_id;

create view public.proofolio_admin_answers with (security_invoker = true) as
select r.user_id, q.run_id, q.question_id, q.position, q.card->>'prompt' as question,
  q.card->'quotes' as quotes, q.card->'pages' as pages, q.card->>'projectTitle' as project_title,
  q.card->>'intent' as intent, q.card->'listenFor' as listen_for,
  a.answer, a.seconds, a.saved_at
from public.proofolio_questions q join public.proofolio_runs r on r.id = q.run_id
left join public.proofolio_answers a on a.run_id = q.run_id and a.question_id = q.question_id;
revoke all on public.proofolio_admin_runs, public.proofolio_admin_answers from public, anon, authenticated, service_role;
grant select on public.proofolio_admin_runs, public.proofolio_admin_answers to service_role;

commit;
