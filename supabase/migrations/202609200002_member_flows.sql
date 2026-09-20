-- Additive follow-up to 202609200001. Existing runs/questions/answers are preserved.
begin;
create unique index proofolio_users_auth_unique on public.proofolio_users(auth_user_id) where auth_user_id is not null;
alter table public.proofolio_runs drop constraint proofolio_runs_track_check;
alter table public.proofolio_runs add constraint proofolio_runs_track_check check (track in ('design','marketing','coding'));
alter table public.proofolio_runs add column expires_at timestamptz not null default (now() + interval '30 days');
alter table public.proofolio_runs add column deleted_at timestamptz;
create index proofolio_runs_expiry_idx on public.proofolio_runs(expires_at);

create table public.proofolio_examples (
  slug text primary key check (slug in ('design','marketing','coding')),
  title text not null,
  source_run_id uuid not null references public.proofolio_runs(id),
  result jsonb not null check (jsonb_typeof(result->'questions') = 'array' and jsonb_array_length(result->'questions') between 6 and 10),
  notice text not null,
  created_at timestamptz not null default now()
);
create index proofolio_examples_source_idx on public.proofolio_examples(source_run_id);
alter table public.proofolio_examples enable row level security;
revoke all on public.proofolio_examples from public, anon, authenticated, service_role;
grant select, insert on public.proofolio_examples to service_role;

-- Browser roles still cannot query private data; verified server routes check ownership.
-- Atomic per-question submission. Equal retries are allowed, edits are not.
create function public.proofolio_save_answer(p_run_id uuid, p_user_id text, p_answer jsonb) returns text
language plpgsql security invoker set search_path = '' as $$
declare r public.proofolio_runs; a public.proofolio_answers;
begin
  select * into r from public.proofolio_runs where id=p_run_id and user_id=p_user_id for update;
  if not found or r.state <> 'complete' or r.deleted_at is not null or r.expires_at <= now() then
    raise exception 'Active completed owned run required';
  end if;
  if jsonb_typeof(p_answer) is distinct from 'object' or jsonb_typeof(p_answer->'answer') is distinct from 'string'
    or jsonb_typeof(p_answer->'questionId') is distinct from 'string' or jsonb_typeof(p_answer->'seconds') is distinct from 'number'
    or (p_answer->>'seconds') !~ '^[0-9]+$' or (select count(*) from jsonb_object_keys(p_answer)) <> 3
    or not exists(select 1 from public.proofolio_questions where run_id=r.id and question_id=p_answer->>'questionId') then
    raise exception 'Invalid answer';
  end if;
  insert into public.proofolio_answers(run_id,question_id,answer,seconds)
    values(r.id,p_answer->>'questionId',p_answer->>'answer',(p_answer->>'seconds')::bigint)
    on conflict(run_id,question_id) do nothing;
  select * into strict a from public.proofolio_answers where run_id=r.id and question_id=p_answer->>'questionId';
  if a.answer is distinct from p_answer->>'answer' or a.seconds is distinct from (p_answer->>'seconds')::bigint then
    raise exception 'Saved answer is immutable' using errcode='23505';
  end if;
  return a.question_id;
end;
$$;
revoke all on function public.proofolio_save_answer(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.proofolio_save_answer(uuid,text,jsonb) to service_role;

-- Runtime per-user cap, serialized before launching a paid process.
create function public.proofolio_start_member_run(p_run jsonb) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare p_user_id text := p_run->>'user_id';
begin
  -- ponytail: one paid worker globally; add a real queue if concurrent demand warrants it.
  perform pg_advisory_xact_lock(2056092000);
  if not exists(select 1 from public.proofolio_users where id=p_user_id and auth_user_id is not null) then raise exception 'Member required'; end if;
  if (select count(*) from public.proofolio_runs where user_id=p_user_id and started_at>now()-interval '1 day') >= 3 then
    raise exception 'Daily limit reached';
  end if;
  if exists(select 1 from public.proofolio_runs where state in ('queued','running') and started_at>now()-interval '2 hours') then
    raise exception 'Analysis already running';
  end if;
  return public.proofolio_sync_run(p_run);
end;
$$;
revoke all on function public.proofolio_start_member_run(jsonb) from public,anon,authenticated;
grant execute on function public.proofolio_start_member_run(jsonb) to service_role;

-- Retention worker removes Storage objects first, then calls this for expired rows.
-- Only this guarded function can delete; the application keeps no table DELETE privilege.
create function public.proofolio_purge_run(p_run_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.proofolio_runs where id=p_run_id and expires_at<=now() for update;
  if not found or exists(select 1 from public.proofolio_examples where source_run_id=p_run_id) then raise exception 'Not purgeable'; end if;
  delete from public.proofolio_answers where run_id=p_run_id;
  delete from public.proofolio_questions where run_id=p_run_id;
  delete from public.proofolio_runs where id=p_run_id;
end;
$$;
revoke all on function public.proofolio_purge_run(uuid) from public,anon,authenticated;
grant execute on function public.proofolio_purge_run(uuid) to service_role;
commit;
