-- Additive contest access. Existing members, recruiting data and examples are unchanged.
begin;
alter table public.proofolio_users add column is_guest boolean not null default false;
alter table public.proofolio_users add column guest_last_started_at timestamptz;

create function public.proofolio_start_guest_run(p_run jsonb, p_expires_at timestamptz) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare u public.proofolio_users; run_id uuid;
begin
  -- Same lock as member admission: anonymous visitors cannot bypass the global worker limit.
  perform pg_advisory_xact_lock(2056092000);
  if p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '24 hours'
    or p_run->>'state' is distinct from 'running'
    or (p_run->>'requested_question_count')::integer not between 6 and 10
    or abs(extract(epoch from (now() - (p_run->>'started_at')::timestamptz))) > 60 then
    raise exception 'Invalid guest admission';
  end if;
  insert into public.proofolio_users(id,is_guest) values (p_run->>'user_id',true) on conflict (id) do nothing;
  select * into strict u from public.proofolio_users where id=p_run->>'user_id';
  if not u.is_guest or u.auth_user_id is not null then raise exception 'Guest required'; end if;
  if u.guest_last_started_at > now()-interval '1 day' then
    raise sqlstate 'PT429' using message='Guest daily limit reached';
  end if;
  if exists(select 1 from public.proofolio_runs where state in ('queued','running') and started_at>now()-interval '2 hours') then
    raise sqlstate 'PT409' using message='Analysis already running';
  end if;
  run_id := public.proofolio_sync_run(p_run);
  update public.proofolio_users set guest_last_started_at=now() where id=u.id;
  update public.proofolio_runs set expires_at=p_expires_at where id=run_id;
  return run_id;
end;
$$;
revoke all on function public.proofolio_start_guest_run(jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.proofolio_start_guest_run(jsonb,timestamptz) to service_role;

-- Called by the retention worker only. Never touches pre-existing anonymous example owners.
create function public.proofolio_expire_guests() returns void
language plpgsql security invoker set search_path = '' as $$
begin
  update public.proofolio_runs r set expires_at=least(r.expires_at,now())
    from public.proofolio_users u where r.user_id=u.id and u.is_guest
    and not exists(select 1 from public.proofolio_examples e where e.source_run_id=r.id);
end;
$$;
revoke all on function public.proofolio_expire_guests() from public,anon,authenticated;
grant execute on function public.proofolio_expire_guests() to service_role;

create function public.proofolio_purge_guest_profiles() returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.proofolio_users u where u.is_guest and u.auth_user_id is null
    and coalesce(u.guest_last_started_at,u.created_at)<=now()-interval '24 hours'
    and not exists(select 1 from public.proofolio_runs r where r.user_id=u.id)
    and not exists(select 1 from public.proofolio_tests t where t.owner_id=u.id)
    and not exists(select 1 from public.proofolio_submissions s where s.user_id=u.id);
end;
$$;
revoke all on function public.proofolio_purge_guest_profiles() from public,anon,authenticated;
grant execute on function public.proofolio_purge_guest_profiles() to service_role;
commit;
