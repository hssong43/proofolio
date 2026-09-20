-- Additive: keep existing Auth, runs, questions, answers, examples and Storage.
-- Apply after 001 + 002. No mock accounts, scores or client-supplied questions.
begin;
create table public.proofolio_tests (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null references public.proofolio_users(id),
  code text not null unique check (code ~ '^[A-HJ-NP-Z2-9]{6}$'),
  title text not null check (char_length(btrim(title)) between 1 and 80),
  role text not null check (role in ('designer','dev','mkt')),
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at > starts_at),
  question_count smallint not null default 10 check (question_count between 6 and 10),
  total_seconds smallint not null default 40 check (total_seconds between 10 and 120),
  created_at timestamptz not null default now()
);
create index proofolio_tests_owner_idx on public.proofolio_tests(owner_id, created_at desc);

create table public.proofolio_submissions (
  id uuid primary key default gen_random_uuid(),
  test_id uuid not null references public.proofolio_tests(id) on delete cascade,
  user_id text not null references public.proofolio_users(id),
  candidate_name text not null check (char_length(btrim(candidate_name)) between 1 and 40),
  birth_date date not null check (birth_date >= date '1900-01-01'),
  phone text not null check (phone ~ '^[0-9]{10,11}$'),
  consent_at timestamptz not null default now(),
  joined_at timestamptz not null default now(),
  completed_at timestamptz,
  -- Expiring/deleting a member's source run must not block the existing retention worker.
  run_id uuid unique references public.proofolio_runs(id) on delete set null,
  expires_at timestamptz not null default (now() + interval '30 days'),
  unique (test_id, user_id)
);
create index proofolio_submissions_user_idx on public.proofolio_submissions(user_id);
create index proofolio_submissions_expiry_idx on public.proofolio_submissions(expires_at);
alter table public.proofolio_tests enable row level security;
alter table public.proofolio_submissions enable row level security;
revoke all on public.proofolio_tests, public.proofolio_submissions from public, anon, authenticated, service_role;
grant select, insert on public.proofolio_tests to service_role;
grant select, insert, update on public.proofolio_submissions to service_role;

create view public.proofolio_test_summaries with (security_invoker=true) as
select t.*,
  (select count(*) from public.proofolio_submissions s where s.test_id=t.id and s.expires_at>now()) as submission_count,
  (select count(*) from public.proofolio_submissions s where s.test_id=t.id and s.expires_at>now() and s.completed_at is not null) as completed_count
from public.proofolio_tests t;
revoke all on public.proofolio_test_summaries from public,anon,authenticated;
grant select on public.proofolio_test_summaries to service_role;

create function public.proofolio_join_test(p_code text, p_user_id text, p_candidate jsonb, p_consent boolean)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare t public.proofolio_tests; s public.proofolio_submissions;
begin
  if p_consent is distinct from true or not exists (
    select 1 from public.proofolio_users where id=p_user_id and auth_user_id is not null
  ) then raise exception 'Consenting member required'; end if;
  select * into t from public.proofolio_tests where code=p_code;
  if not found or now() < t.starts_at or now() >= t.ends_at then raise exception 'Open test required'; end if;
  if jsonb_typeof(p_candidate) is distinct from 'object'
    or jsonb_typeof(p_candidate->'name') is distinct from 'string'
    or jsonb_typeof(p_candidate->'birthDate') is distinct from 'string'
    or jsonb_typeof(p_candidate->'phone') is distinct from 'string'
    or (p_candidate->>'birthDate')::date > current_date then raise exception 'Invalid candidate'; end if;
  insert into public.proofolio_submissions(test_id,user_id,candidate_name,birth_date,phone)
    values(t.id,p_user_id,p_candidate->>'name',(p_candidate->>'birthDate')::date,p_candidate->>'phone')
    on conflict(test_id,user_id) do nothing;
  select * into strict s from public.proofolio_submissions where test_id=t.id and user_id=p_user_id;
  if s.expires_at <= now() or s.candidate_name is distinct from p_candidate->>'name'
    or s.birth_date is distinct from (p_candidate->>'birthDate')::date or s.phone is distinct from p_candidate->>'phone'
    then raise exception 'Submission identity conflict'; end if;
  return s.id;
end;
$$;

create function public.proofolio_link_submission_run(p_submission_id uuid, p_user_id text, p_run_id uuid)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare s public.proofolio_submissions; t public.proofolio_tests; r public.proofolio_runs;
begin
  select * into s from public.proofolio_submissions where id=p_submission_id and user_id=p_user_id for update;
  if not found or s.expires_at<=now() then raise exception 'Owned submission required'; end if;
  select * into strict t from public.proofolio_tests where id=s.test_id;
  select * into r from public.proofolio_runs where id=p_run_id and user_id=p_user_id for share;
  if not found or r.deleted_at is not null or r.expires_at<=now()
    or r.track is distinct from (case t.role when 'designer' then 'design' when 'dev' then 'coding' else 'marketing' end)
    or r.requested_question_count<>t.question_count or r.started_at<s.joined_at
    then raise exception 'Matching owned run required'; end if;
  if s.run_id=p_run_id then return p_run_id; end if;
  if s.run_id is not null or s.completed_at is not null or now()<t.starts_at or now()>=t.ends_at
    then raise exception 'Submission run is immutable or test closed'; end if;
  update public.proofolio_submissions set run_id=p_run_id where id=s.id;
  return p_run_id;
end;
$$;

create function public.proofolio_complete_submission(p_submission_id uuid, p_user_id text, p_run_id uuid)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare s public.proofolio_submissions; t public.proofolio_tests; r public.proofolio_runs;
begin
  select * into s from public.proofolio_submissions where id=p_submission_id and user_id=p_user_id for update;
  if not found or s.expires_at<=now() or s.run_id is distinct from p_run_id or p_run_id is null
    then raise exception 'Owned linked submission required'; end if;
  -- Lost-ACK replay succeeds even after the deadline; it never rewrites answers.
  if s.completed_at is not null then return s.id; end if;
  select * into strict t from public.proofolio_tests where id=s.test_id;
  if now()<t.starts_at or now()>=t.ends_at then raise exception 'Test closed'; end if;
  select * into r from public.proofolio_runs where id=p_run_id and user_id=p_user_id for update;
  if not found or r.state<>'complete' or r.deleted_at is not null or r.expires_at<=now()
    or r.generated_question_count=0 or
    (select count(*) from public.proofolio_answers where run_id=r.id)<>r.generated_question_count
    then raise exception 'All canonical answers must be saved first'; end if;
  update public.proofolio_submissions set completed_at=now() where id=s.id;
  return s.id;
end;
$$;

create function public.proofolio_delete_test(p_test_id uuid, p_owner_id text) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.proofolio_tests where id=p_test_id and owner_id=p_owner_id;
  if not found then raise exception 'Owned test required'; end if;
  -- Cascades recruiting metadata only; member runs/questions/answers are untouched.
  return p_test_id;
end;
$$;

create function public.proofolio_purge_recruiting() returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.proofolio_submissions where expires_at<=now();
  delete from public.proofolio_tests where ends_at<=now()-interval '30 days';
end;
$$;
revoke all on function public.proofolio_join_test(text,text,jsonb,boolean),
  public.proofolio_link_submission_run(uuid,text,uuid), public.proofolio_complete_submission(uuid,text,uuid),
  public.proofolio_delete_test(uuid,text), public.proofolio_purge_recruiting() from public,anon,authenticated;
grant execute on function public.proofolio_join_test(text,text,jsonb,boolean),
  public.proofolio_link_submission_run(uuid,text,uuid), public.proofolio_complete_submission(uuid,text,uuid),
  public.proofolio_delete_test(uuid,text), public.proofolio_purge_recruiting() to service_role;
notify pgrst, 'reload schema';
commit;
