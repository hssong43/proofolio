-- After 001/002/003/004; synthetic data always rolls back.
begin;
do $$
declare
  auth_a uuid:=gen_random_uuid(); auth_b uuid:=gen_random_uuid();
  owner_id text:=md5(auth_a::text)||md5(auth_a::text);
  member_id text:=md5(auth_b::text)||md5(auth_b::text);
  tid uuid:=gen_random_uuid(); sid uuid:=gen_random_uuid(); rid uuid:=gen_random_uuid();
  summary record;
begin
  insert into auth.users(id) values(auth_a),(auth_b);
  insert into public.proofolio_users(id,auth_user_id) values(owner_id,auth_a),(member_id,auth_b);
  set local role service_role;
  insert into public.proofolio_tests(id,owner_id,code,title,role,starts_at,ends_at)
    values(tid,owner_id,'ZZZ235','SYNTHETIC-SCORES','designer',now()-interval '1 hour',now()+interval '1 hour');
  insert into public.proofolio_runs(id,user_id,track,file_name,state,started_at,result)
    values(rid,member_id,'design','x.pdf','complete',now(),'{"questions":[{"id":"q1","prompt":"p"}]}'::jsonb);
  insert into public.proofolio_submissions(id,test_id,user_id,candidate_name,birth_date,phone,run_id)
    values(sid,tid,member_id,'응시자','2000-01-01','01000000000',rid);
  begin
    perform public.proofolio_save_submission_score(sid,member_id,'{"state":"running"}'::jsonb);
    raise exception 'Score before completion' using errcode='23514';
  exception when others then if sqlerrm='Score before completion' then raise; end if; end;
  update public.proofolio_submissions set completed_at=now() where id=sid;
  begin
    perform public.proofolio_save_submission_score(sid,owner_id,'{"state":"running"}'::jsonb);
    raise exception 'Owner bypass' using errcode='23514';
  exception when others then if sqlerrm='Owner bypass' then raise; end if; end;
  perform public.proofolio_save_submission_score(sid,member_id,'{"state":"running","model":"m"}'::jsonb);
  begin
    perform public.proofolio_save_submission_score(sid,member_id,'{"state":"complete"}'::jsonb);
    raise exception 'Complete without score' using errcode='23514';
  exception when others then if sqlerrm='Complete without score' then raise; end if; end;
  perform public.proofolio_save_submission_score(sid,member_id,'{"state":"complete","model":"m","overallScore":78,"items":[{"questionId":"q1","score":78}],"costUsd":0.12}'::jsonb);
  select * into summary from public.proofolio_test_summaries where id=tid;
  if summary.scored_count<>1 or summary.average_score<>78 or summary.completed_count<>1 then raise exception 'Summary aggregates wrong'; end if;
  perform public.proofolio_save_submission_score(sid,member_id,'{"state":"failed","error":"boom"}'::jsonb);
  if (select state from public.proofolio_submission_scores where submission_id=sid)<>'failed' then raise exception 'Upsert failed'; end if;
  delete from public.proofolio_tests where id=tid;
  if exists (select 1 from public.proofolio_submission_scores where submission_id=sid) then raise exception 'Cascade missing'; end if;
end $$;
rollback;
