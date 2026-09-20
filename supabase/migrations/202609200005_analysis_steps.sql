-- Additive Vercel execution. Run after 001-004; does not enable paid calls or reset old ledgers.
begin;
alter table public.proofolio_runs add column execution text not null default 'local' check (execution in ('local','steps'));
alter table public.proofolio_runs add column progress_stage smallint not null default 0 check (progress_stage between 0 and 3);
alter table public.proofolio_runs add column last_event text;

create table public.proofolio_analysis_jobs (
  run_id uuid primary key references public.proofolio_runs(id) on delete cascade,
  version text not null,
  checkpoint jsonb not null default '{"calls":[]}',
  lease_token uuid,
  lease_until timestamptz,
  not_before timestamptz not null default now(),
  check (jsonb_typeof(checkpoint->'calls')='array' and jsonb_array_length(checkpoint->'calls')<=120),
  check (octet_length(checkpoint::text)<=16777216)
);
-- A singleton across deployments and users. Zero/blocked until the operator imports an approved ledger.
create table public.proofolio_execution_budget (
  id boolean primary key default true check (id),
  limit_usd numeric not null default 0 check (limit_usd>=0 and limit_usd<100000),
  spent_usd numeric not null default 0 check (spent_usd>=0 and spent_usd<100000),
  reserved_usd numeric not null default 0 check (reserved_usd>=0 and reserved_usd<100000),
  blocked boolean not null default true,
  legacy_sha256 text check (legacy_sha256 ~ '^[a-f0-9]{64}$')
);
insert into public.proofolio_execution_budget(id) values(true);
-- No FK to a retained portfolio: financial records survive private-file deletion, with no source text.
create table public.proofolio_execution_calls (
  id uuid primary key,
  run_id uuid not null,
  request_key text not null check (request_key ~ '^[a-f0-9]{64}$'),
  ordinal integer not null check (ordinal between 1 and 120),
  model text not null,
  reserved_usd numeric not null check (reserved_usd>0 and reserved_usd<100000),
  actual_usd numeric check (actual_usd>=0 and actual_usd<100000),
  state text not null default 'reserved' check (state in ('reserved','settled','unknown')),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  unique(run_id,ordinal)
);
create index proofolio_execution_pending_idx on public.proofolio_execution_calls(state) where state<>'settled';
alter table public.proofolio_analysis_jobs enable row level security;
alter table public.proofolio_execution_budget enable row level security;
alter table public.proofolio_execution_calls enable row level security;
revoke all on public.proofolio_analysis_jobs,public.proofolio_execution_budget,public.proofolio_execution_calls from public,anon,authenticated,service_role;
grant select on public.proofolio_analysis_jobs,public.proofolio_execution_budget,public.proofolio_execution_calls to service_role;

create function public.proofolio_init_analysis(p_run_id uuid,p_user_id text,p_version text,p_limit numeric) returns uuid
language plpgsql security definer set search_path='' as $$
declare r public.proofolio_runs; b public.proofolio_execution_budget;
begin
  select * into strict r from public.proofolio_runs where id=p_run_id and user_id=p_user_id
    and deleted_at is null and expires_at>now() for update;
  if r.state not in ('queued','running') or p_version is null or length(p_version) not between 1 and 120 then
    raise exception 'Invalid analysis';
  end if;
  select * into strict b from public.proofolio_execution_budget where id;
  if p_limit is null or p_limit<=0 or p_limit>10 or b.limit_usd<>p_limit or b.blocked or b.legacy_sha256 is null
    or b.spent_usd+b.reserved_usd>=b.limit_usd then
    raise sqlstate 'PT402' using message='Approved shared budget required';
  end if;
  insert into public.proofolio_analysis_jobs(run_id,version) values(r.id,p_version) on conflict do nothing;
  if not exists(select 1 from public.proofolio_analysis_jobs where run_id=r.id and version=p_version) then
    raise exception 'Analysis version mismatch';
  end if;
  update public.proofolio_runs set state='running',execution='steps' where id=r.id;
  return r.id;
end;
$$;

create function public.proofolio_claim_analysis(p_run_id uuid,p_user_id text,p_version text,p_token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.proofolio_runs; j public.proofolio_analysis_jobs;
begin
  select * into strict r from public.proofolio_runs where id=p_run_id and user_id=p_user_id
    and deleted_at is null and expires_at>now() for update;
  if r.state<>'running' or r.execution<>'steps' then return null; end if;
  select * into strict j from public.proofolio_analysis_jobs where run_id=r.id for update;
  if j.lease_until>now() or j.not_before>now() then return null; end if;
  if exists(select 1 from public.proofolio_execution_calls where run_id=r.id and state<>'settled') then
    -- A timeout after dispatch is NOT permission to charge again. Retain the reservation and stop.
    update public.proofolio_execution_budget set blocked=true where id;
    update public.proofolio_runs set state='failed',finished_at=now(),error='이전 AI 요청의 비용 또는 응답을 확인하지 못했어요. 중복 결제 방지를 위해 중단했어요.' where id=r.id;
    return null;
  end if;
  if j.version<>p_version then
    update public.proofolio_runs set state='failed',finished_at=now(),error='분석 중 배포 버전이 변경됐어요. 이전 요청을 다시 실행하지 않았어요.' where id=r.id;
    return null;
  end if;
  if p_token is null then raise exception 'Lease token required'; end if;
  -- Longer than the route's 300-second hard limit; never reclaim a still-running invocation.
  update public.proofolio_analysis_jobs set lease_token=p_token,lease_until=now()+interval '6 minutes' where run_id=r.id;
  return j.checkpoint;
end;
$$;

create function public.proofolio_reserve_execution(p_run_id uuid,p_user_id text,p_token uuid,p_id uuid,p_key text,p_model text,p_usd numeric,p_limit numeric) returns uuid
language plpgsql security definer set search_path='' as $$
declare j public.proofolio_analysis_jobs; b public.proofolio_execution_budget;
begin
  perform 1 from public.proofolio_runs where id=p_run_id and user_id=p_user_id and state='running'
    and deleted_at is null and expires_at>now() for update;
  if not found then raise exception 'Owned running analysis required'; end if;
  select * into strict j from public.proofolio_analysis_jobs where run_id=p_run_id for update;
  if j.lease_token is distinct from p_token or j.lease_until<=now() or jsonb_array_length(j.checkpoint->'calls')>=120 then
    raise exception 'Analysis lease lost';
  end if;
  select * into strict b from public.proofolio_execution_budget where id for update;
  if p_usd is null or p_usd<=0 or p_usd>=100000 or p_limit is null or p_limit<=0 or p_limit>10
    or b.blocked or b.limit_usd<>p_limit or b.legacy_sha256 is null
    or b.spent_usd+b.reserved_usd+p_usd>b.limit_usd
    or exists(select 1 from public.proofolio_execution_calls where state<>'settled') then
    raise sqlstate 'PT402' using message='Budget unavailable';
  end if;
  insert into public.proofolio_execution_calls(id,run_id,request_key,ordinal,model,reserved_usd)
    values(p_id,p_run_id,p_key,jsonb_array_length(j.checkpoint->'calls')+1,p_model,p_usd);
  update public.proofolio_execution_budget set reserved_usd=reserved_usd+p_usd where id;
  return p_id;
end;
$$;

-- Response + actual cost settle together. A failed DB save leaves the reservation unavailable.
create function public.proofolio_finish_execution(p_run_id uuid,p_user_id text,p_token uuid,p_id uuid,p_actual numeric,p_checkpoint jsonb,p_wait_ms integer) returns boolean
language plpgsql security definer set search_path='' as $$
declare j public.proofolio_analysis_jobs; c public.proofolio_execution_calls; b public.proofolio_execution_budget;
begin
  perform 1 from public.proofolio_runs where id=p_run_id and user_id=p_user_id for update;
  if not found then raise exception 'Owned analysis required'; end if;
  select * into strict j from public.proofolio_analysis_jobs where run_id=p_run_id for update;
  select * into strict b from public.proofolio_execution_budget where id for update;
  select * into strict c from public.proofolio_execution_calls where id=p_id and run_id=p_run_id for update;
  if j.lease_token is distinct from p_token or c.state<>'reserved'
    or jsonb_typeof(p_checkpoint->'calls') is distinct from 'array'
    or jsonb_array_length(p_checkpoint->'calls')<>c.ordinal
    or (p_checkpoint->'calls'->(c.ordinal-1)->>'key') is distinct from c.request_key
    or (p_checkpoint->'calls')-(c.ordinal-1) is distinct from j.checkpoint->'calls'
    or p_wait_ms is null or p_wait_ms not between 0 and 120000
    or (p_actual is not null and (p_actual<0 or p_actual>=100000)) then raise exception 'Invalid settlement'; end if;
  update public.proofolio_execution_calls set actual_usd=p_actual,state=case when p_actual is null then 'unknown' else 'settled' end,settled_at=now() where id=p_id;
  update public.proofolio_execution_budget set
    spent_usd=spent_usd+coalesce(p_actual,0),
    reserved_usd=reserved_usd-case when p_actual is null then 0 else c.reserved_usd end,
    blocked=blocked or p_actual is null or p_actual>c.reserved_usd
      or spent_usd+reserved_usd-c.reserved_usd+coalesce(p_actual,c.reserved_usd)>limit_usd
    where id returning * into b;
  update public.proofolio_analysis_jobs set checkpoint=p_checkpoint,not_before=now()+p_wait_ms*interval '1 millisecond' where run_id=p_run_id;
  return b.blocked;
end;
$$;

create function public.proofolio_save_analysis(p_run_id uuid,p_user_id text,p_token uuid,p_checkpoint jsonb,p_stage integer,p_event text,p_final jsonb default null) returns void
language plpgsql security definer set search_path='' as $$
declare j public.proofolio_analysis_jobs; r public.proofolio_runs;
begin
  select * into strict r from public.proofolio_runs where id=p_run_id and user_id=p_user_id for update;
  select * into strict j from public.proofolio_analysis_jobs where run_id=r.id for update;
  if j.lease_token is distinct from p_token or r.state<>'running' or p_stage is null or p_stage not between 0 and 3
    or p_checkpoint->'calls' is distinct from j.checkpoint->'calls' then raise exception 'Analysis lease/checkpoint conflict'; end if;
  if p_final is not null then
    if p_final->>'id' is distinct from r.id::text or p_final->>'user_id' is distinct from p_user_id
      or p_final->>'state' not in ('complete','failed') then raise exception 'Invalid final result'; end if;
    perform public.proofolio_sync_run(p_final);
  end if;
  update public.proofolio_analysis_jobs set checkpoint=p_checkpoint,lease_token=null,lease_until=null where run_id=r.id;
  update public.proofolio_runs set progress_stage=p_stage,last_event=left(p_event,80) where id=r.id;
end;
$$;

revoke all on function public.proofolio_init_analysis(uuid,text,text,numeric), public.proofolio_claim_analysis(uuid,text,text,uuid),
  public.proofolio_reserve_execution(uuid,text,uuid,uuid,text,text,numeric,numeric),
  public.proofolio_finish_execution(uuid,text,uuid,uuid,numeric,jsonb,integer),
  public.proofolio_save_analysis(uuid,text,uuid,jsonb,integer,text,jsonb) from public,anon,authenticated;
grant execute on function public.proofolio_init_analysis(uuid,text,text,numeric), public.proofolio_claim_analysis(uuid,text,text,uuid),
  public.proofolio_reserve_execution(uuid,text,uuid,uuid,text,text,numeric,numeric),
  public.proofolio_finish_execution(uuid,text,uuid,uuid,numeric,jsonb,integer),
  public.proofolio_save_analysis(uuid,text,uuid,jsonb,integer,text,jsonb) to service_role;
commit;
