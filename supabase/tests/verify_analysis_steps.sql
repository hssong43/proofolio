-- Isolated/SQL Editor regression only. Every synthetic write rolls back.
begin;
update public.proofolio_execution_budget set limit_usd=10,spent_usd=1,reserved_usd=.3,blocked=false,legacy_sha256=repeat('f',64) where id;
do $$
declare r uuid:=gen_random_uuid(); u text:=repeat('c',64); t uuid:=gen_random_uuid(); t2 uuid:=gen_random_uuid();
  call_id uuid:=gen_random_uuid(); cp jsonb:='{"calls":[]}'; payload jsonb; blocked boolean;
begin
  payload:=jsonb_build_object('id',r,'user_id',u,'track','design','file_name','SYNTHETIC.pdf',
    'pdf_sha256',repeat('d',64),'requested_question_count',6,'state','queued','started_at',now());
  perform public.proofolio_sync_run(payload);
  perform public.proofolio_init_analysis(r,u,'fixture-v1',10);
  begin
    perform public.proofolio_claim_analysis(r,repeat('e',64),'fixture-v1',t);
    raise exception 'Foreign owner accepted';
  exception when no_data_found then null; end;
  if public.proofolio_claim_analysis(r,u,'fixture-v1',t)<>cp then raise exception 'Missing checkpoint'; end if;
  if public.proofolio_claim_analysis(r,u,'fixture-v1',t2) is not null then raise exception 'Concurrent lease accepted'; end if;
  perform public.proofolio_reserve_execution(r,u,t,call_id,repeat('a',64),'synthetic/model',2,10);
  begin
    perform public.proofolio_reserve_execution(r,u,t,gen_random_uuid(),repeat('b',64),'synthetic/model',2,10);
    raise exception 'Concurrent reservation accepted';
  exception when sqlstate 'PT402' then null; end;
  cp:='{"calls":[{"key":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","raw":{"synthetic":true}}]}';
  blocked:=public.proofolio_finish_execution(r,u,t,call_id,.2,cp,30000);
  if blocked or not exists(select 1 from public.proofolio_execution_budget where spent_usd=1.2 and reserved_usd=.3) then
    raise exception 'Settlement must preserve old spend and unknown holds'; end if;
  perform public.proofolio_save_analysis(r,u,t,cp,1,'fixture');
  if public.proofolio_claim_analysis(r,u,'fixture-v1',t2) is not null then raise exception 'Retry-After ignored'; end if;
  update public.proofolio_analysis_jobs set not_before=now()-interval '1 second' where run_id=r;
  if public.proofolio_claim_analysis(r,u,'fixture-v1',t2)<>cp then raise exception 'Checkpoint not resumed'; end if;
  perform public.proofolio_save_analysis(r,u,t2,cp,3,'complete',payload||jsonb_build_object('state','complete','finished_at',now(),
    'result',jsonb_build_object('questions',jsonb_build_array(jsonb_build_object('id','q1','prompt','합성 질문')))));
  if (select state from public.proofolio_runs where id=r)<>'complete' then raise exception 'Final result not published'; end if;
  if public.proofolio_claim_analysis(r,u,'fixture-v1',gen_random_uuid()) is not null then raise exception 'Complete run restarted'; end if;
  perform public.proofolio_save_answer(r,u,'{"questionId":"q1","answer":"합성 답변","seconds":3}');
  perform public.proofolio_save_answer(r,u,'{"questionId":"q1","answer":"합성 답변","seconds":3}');
  if (select count(*) from public.proofolio_answers where run_id=r)<>1 then raise exception 'Answer retry duplicated'; end if;

  r:=gen_random_uuid();t:=gen_random_uuid();call_id:=gen_random_uuid();
  perform public.proofolio_sync_run(payload||jsonb_build_object('id',r));
  perform public.proofolio_init_analysis(r,u,'fixture-v1',10);
  perform public.proofolio_claim_analysis(r,u,'fixture-v1',t);
  perform public.proofolio_reserve_execution(r,u,t,call_id,repeat('b',64),'synthetic/model',2,10);
  update public.proofolio_analysis_jobs set lease_until=now()-interval '1 second' where run_id=r;
  if public.proofolio_claim_analysis(r,u,'fixture-v1',gen_random_uuid()) is not null then raise exception 'Unknown-cost call replayed'; end if;
  if not exists(select 1 from public.proofolio_execution_budget b where b.blocked and reserved_usd=2.3 and spent_usd=1.2) then
    raise exception 'Unknown spend was released'; end if;
  if (select state from public.proofolio_runs where id=r)<>'failed' then raise exception 'Expired paid lease not stopped'; end if;
  if has_function_privilege('anon','public.proofolio_claim_analysis(uuid,text,text,uuid)','execute')
    or has_table_privilege('authenticated','public.proofolio_analysis_jobs','select')
    or has_table_privilege('service_role','public.proofolio_execution_budget','update') then raise exception 'Excess privilege'; end if;
end;
$$;
rollback;
