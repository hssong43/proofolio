-- After 001/002/003; synthetic Auth/data changes always roll back.
begin;
do $$
declare
  auth_a uuid:=gen_random_uuid(); auth_b uuid:=gen_random_uuid(); auth_c uuid:=gen_random_uuid();
  owner_id text:=md5(auth_a::text)||md5(auth_a::text);
  member_id text:=md5(auth_b::text)||md5(auth_b::text);
  other_id text:=md5(auth_c::text)||md5(auth_c::text);
  tid uuid:=gen_random_uuid(); sid uuid; rid uuid:=gen_random_uuid(); foreign_run uuid:=gen_random_uuid();
  candidate jsonb:='{"name":"합성 응시자","birthDate":"2000-01-01","phone":"01000000000"}';
  payload jsonb; i integer;
begin
  insert into auth.users(id) values(auth_a),(auth_b),(auth_c);
  insert into public.proofolio_users(id,auth_user_id) values(owner_id,auth_a),(member_id,auth_b),(other_id,auth_c);
  set local role service_role;
  insert into public.proofolio_tests(id,owner_id,code,title,role,starts_at,ends_at)
    values(tid,owner_id,'ZZZ234','SYNTHETIC-RECRUITING','designer',now()-interval '1 hour',now()+interval '1 hour');
  begin
    perform public.proofolio_join_test('ZZZ234',member_id,candidate,false);
    raise exception 'Consent bypass' using errcode='23514';
  exception when raise_exception then null; end;
  sid:=public.proofolio_join_test('ZZZ234',member_id,candidate,true);
  if public.proofolio_join_test('ZZZ234',member_id,candidate,true)<>sid then raise exception 'Duplicate join'; end if;
  begin
    perform public.proofolio_join_test('ZZZ234',member_id,jsonb_set(candidate,'{name}','"changed"'),true);
    raise exception 'Identity rewrite' using errcode='23514';
  exception when raise_exception then null; end;
  payload:=jsonb_build_object('id',rid,'user_id',member_id,'track','design','file_name','SYNTHETIC.pdf',
    'pdf_sha256',repeat('a',64),'requested_question_count',10,'state','complete','started_at',now(),'finished_at',now(),
    'result',jsonb_build_object('status','needs_review','questions',jsonb_build_array(
      jsonb_build_object('id','q1','prompt','선택 기준을 설명해주세요.'),
      jsonb_build_object('id','q2','prompt','역할을 설명해주세요.'),
      jsonb_build_object('id','q3','prompt','배운 점을 설명해주세요.'))));
  perform public.proofolio_sync_run(payload);
  perform public.proofolio_sync_run(payload||jsonb_build_object('id',foreign_run,'user_id',other_id));
  begin
    perform public.proofolio_link_submission_run(sid,other_id,rid);
    raise exception 'Cross-user submission' using errcode='23514';
  exception when raise_exception then null; end;
  begin
    perform public.proofolio_link_submission_run(sid,member_id,foreign_run);
    raise exception 'Foreign run' using errcode='23514';
  exception when raise_exception then null; end;
  perform public.proofolio_link_submission_run(sid,member_id,rid);
  perform public.proofolio_link_submission_run(sid,member_id,rid);
  begin
    perform public.proofolio_complete_submission(sid,member_id,rid);
    raise exception 'Missing answers accepted' using errcode='23514';
  exception when raise_exception then null; end;
  for i in 1..3 loop
    perform public.proofolio_save_answer(rid,member_id,jsonb_build_object('questionId','q'||i,'answer','합성 답변 '||i,'seconds',4));
  end loop;
  if public.proofolio_complete_submission(sid,member_id,rid)<>sid then raise exception 'Completion failed'; end if;
  if public.proofolio_complete_submission(sid,member_id,rid)<>sid then raise exception 'Completion replay failed'; end if;
  begin
    perform public.proofolio_save_answer(rid,member_id,jsonb_build_object('questionId','q1','answer','changed','seconds',4));
    raise exception 'Answer rewritten' using errcode='23514';
  exception when unique_violation then null; end;
  begin
    perform public.proofolio_complete_submission(sid,other_id,rid);
    raise exception 'Foreign completion' using errcode='23514';
  exception when raise_exception then null; end;
  begin
    perform public.proofolio_delete_test(tid,other_id);
    raise exception 'Foreign deletion' using errcode='23514';
  exception when raise_exception then null; end;
  update public.proofolio_runs set expires_at=now()-interval '1 second' where id=rid;
  perform public.proofolio_purge_run(rid);
  if (select run_id from public.proofolio_submissions where id=sid) is not null then raise exception 'Run purge blocked'; end if;
  update public.proofolio_submissions set expires_at=now()-interval '1 second' where id=sid;
  perform public.proofolio_purge_recruiting();
  if exists(select 1 from public.proofolio_submissions where id=sid)then raise exception 'Expired PII retained';end if;
  perform public.proofolio_delete_test(tid,owner_id);
  if not exists(select 1 from public.proofolio_runs where id=foreign_run)then raise exception 'Member run removed';end if;
  reset role;
end;
$$;
do $$
declare r text; f text;
begin
  foreach r in array array['anon','authenticated'] loop
    if has_table_privilege(r,'public.proofolio_tests','select,insert,update,delete')
      or has_table_privilege(r,'public.proofolio_submissions','select,insert,update,delete')
      or has_table_privilege(r,'public.proofolio_test_summaries','select') then raise exception 'Public PII access'; end if;
    foreach f in array array['proofolio_join_test(text,text,jsonb,boolean)','proofolio_link_submission_run(uuid,text,uuid)',
      'proofolio_complete_submission(uuid,text,uuid)','proofolio_delete_test(uuid,text)','proofolio_purge_recruiting()'] loop
      if has_function_privilege(r,'public.'||f,'execute')then raise exception 'Public RPC access';end if;
    end loop;
  end loop;
end;
$$;
rollback;
