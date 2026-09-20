-- After 001..004. Synthetic rows roll back. No model or Storage calls.
begin;
do $$
declare
  aid uuid:=gen_random_uuid(); member_id text:=repeat('1',64); guest_id text:=repeat('2',64);
  other_id text:=repeat('3',64); rid uuid:=gen_random_uuid(); member_run uuid:=gen_random_uuid();
  p jsonb; answer jsonb:='{"questionId":"q1","answer":"합성 답변","seconds":3}';
begin
  insert into auth.users(id) values(aid);
  insert into public.proofolio_users(id,auth_user_id) values(member_id,aid);
  set local role service_role;
  p:=jsonb_build_object('id',rid,'user_id',guest_id,'track','design','file_name','SYNTHETIC.pdf',
    'pdf_sha256',repeat('a',64),'requested_question_count',10,'state','running','started_at',now());
  perform public.proofolio_start_guest_run(p,now()+interval '1 hour');
  if not (select is_guest from public.proofolio_users where id=guest_id)
    or (select auth_user_id from public.proofolio_users where id=guest_id) is not null then raise exception 'Not anonymous'; end if;
  begin
    perform public.proofolio_start_guest_run(p||jsonb_build_object('id',gen_random_uuid(),'user_id',other_id),now()+interval '1 hour');
    raise exception 'Concurrent guest allowed' using errcode='23514';
  exception when sqlstate 'PT409' then null; end;
  begin
    perform public.proofolio_start_member_run(p||jsonb_build_object('id',member_run,'user_id',member_id));
    raise exception 'Member bypassed global worker lock' using errcode='23514';
  exception when raise_exception then null; end;
  p:=p||jsonb_build_object('state','complete','finished_at',now(),'result',jsonb_build_object('questions',
    jsonb_build_array(jsonb_build_object('id','q1','prompt','이 작업의 선택 기준은 무엇인가요?'))));
  perform public.proofolio_sync_run(p);
  if (select expires_at from public.proofolio_runs where id=rid)<>now()+interval '1 hour' then raise exception 'Completion extended guest retention';end if;
  perform public.proofolio_save_answer(rid,guest_id,answer);
  perform public.proofolio_save_answer(rid,guest_id,answer);
  begin
    perform public.proofolio_save_answer(rid,other_id,answer);
    raise exception 'Cross-guest answer accepted' using errcode='23514';
  exception when raise_exception then null; end;
  begin
    perform public.proofolio_start_guest_run(p||jsonb_build_object('id',gen_random_uuid(),'state','running'),now()+interval '1 hour');
    raise exception 'Daily quota bypassed' using errcode='23514';
  exception when sqlstate 'PT429' then null; end;
  begin
    perform public.proofolio_start_guest_run(p||jsonb_build_object('id',gen_random_uuid(),'state','running','user_id',member_id),now()+interval '1 hour');
    raise exception 'Member converted to guest' using errcode='23514';
  exception when raise_exception then null; end;
  begin
    perform public.proofolio_start_guest_run(p||jsonb_build_object('id',gen_random_uuid(),'state','running','user_id',other_id),now()+interval '25 hours');
    raise exception 'Long retention allowed' using errcode='23514';
  exception when raise_exception then null; end;
  perform public.proofolio_start_member_run((p-'result'-'finished_at')||jsonb_build_object('id',member_run,'state','running','user_id',member_id));
  perform public.proofolio_expire_guests();
  if (select expires_at from public.proofolio_runs where id=member_run)<=now() then raise exception 'Member data expired';end if;
  begin
    perform public.proofolio_save_answer(rid,guest_id,answer);
    raise exception 'Expired guest write allowed' using errcode='23514';
  exception when raise_exception then null; end;
  perform public.proofolio_purge_run(rid);
  begin
    perform public.proofolio_start_guest_run((p-'result'-'finished_at')||jsonb_build_object('id',gen_random_uuid(),'state','running'),now()+interval '1 hour');
    raise exception 'Deleting run reset quota' using errcode='23514';
  exception when sqlstate 'PT429' then null; end;
  perform public.proofolio_purge_guest_profiles();
  if not exists(select 1 from public.proofolio_users where id=guest_id) then raise exception 'Quota profile removed too early';end if;
  update public.proofolio_users set guest_last_started_at=now()-interval '25 hours' where id=guest_id;
  perform public.proofolio_purge_guest_profiles();
  if exists(select 1 from public.proofolio_users where id=guest_id) then raise exception 'Guest profile retained';end if;
  if not exists(select 1 from public.proofolio_users where id=member_id) then raise exception 'Member profile removed';end if;
  reset role;
end;
$$;
do $$
declare r text; f text;
begin
  foreach r in array array['anon','authenticated'] loop
    foreach f in array array['proofolio_start_guest_run(jsonb,timestamptz)','proofolio_expire_guests()','proofolio_purge_guest_profiles()'] loop
      if has_function_privilege(r,'public.'||f,'execute') then raise exception 'Public guest RPC access';end if;
    end loop;
    if has_table_privilege(r,'public.proofolio_users','select,insert,update,delete') then raise exception 'Public profile access';end if;
  end loop;
end;
$$;
rollback;
