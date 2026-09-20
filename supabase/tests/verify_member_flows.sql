-- Run after migrations 001 + 002. Synthetic rows are rolled back.
begin;
set local role service_role;
do $$
declare
  run_id uuid := gen_random_uuid();
  owner_id text := repeat('d',64);
  payload jsonb;
  answer jsonb := jsonb_build_object('questionId','q1','answer','합성 답변','seconds',3);
begin
  payload := jsonb_build_object('id',run_id,'user_id',owner_id,'track','coding','file_name','SYNTHETIC-TEST.ts',
    'pdf_sha256',repeat('e',64),'requested_question_count',6,'state','complete','started_at',now(),
    'finished_at',now(),'result',jsonb_build_object('status','needs_review','questions',jsonb_build_array(
      jsonb_build_object('id','q1','prompt','이 코드의 선택 기준을 설명해주세요.'))));
  perform public.proofolio_sync_run(payload);
  perform public.proofolio_save_answer(run_id,owner_id,answer);
  perform public.proofolio_save_answer(run_id,owner_id,answer);
  if (select count(*) from public.proofolio_answers a where a.run_id = (payload->>'id')::uuid) <> 1 then
    raise exception 'Duplicate answer';
  end if;
  begin
    perform public.proofolio_save_answer(run_id,owner_id,jsonb_set(answer,'{answer}','"changed"'));
    raise exception 'Answer overwrite allowed' using errcode='23514';
  exception when unique_violation then null; end;
  begin
    perform public.proofolio_save_answer(run_id,repeat('f',64),answer);
    raise exception 'Cross-user answer allowed' using errcode='23514';
  exception when raise_exception then null; end;
  begin
    perform public.proofolio_purge_run(run_id);
    raise exception 'Non-expired purge allowed' using errcode='23514';
  exception when raise_exception then null; end;
  update public.proofolio_runs r set expires_at=now()-interval '1 second' where r.id=run_id;
  begin
    perform public.proofolio_save_answer(run_id,owner_id,answer);
    raise exception 'Expired answer allowed' using errcode='23514';
  exception when raise_exception then null; end;
  perform public.proofolio_purge_run(run_id);
  if exists(select 1 from public.proofolio_runs r where r.id=run_id) then
    raise exception 'Expired run not purged';
  end if;
end;
$$;
reset role;
do $$
declare role_name text; function_name text;
begin
  foreach role_name in array array['anon','authenticated'] loop
    if has_table_privilege(role_name,'public.proofolio_examples','select,insert,update,delete') then
      raise exception 'Unexpected example table access';
    end if;
    foreach function_name in array array['proofolio_save_answer(uuid,text,jsonb)',
      'proofolio_start_member_run(jsonb)','proofolio_purge_run(uuid)'] loop
      if has_function_privilege(role_name,'public.' || function_name,'execute') then
        raise exception 'Unexpected RPC access: % %',role_name,function_name;
      end if;
    end loop;
  end loop;
  if has_table_privilege('service_role','public.proofolio_answers','update,delete') or
    has_table_privilege('service_role','public.proofolio_questions','update,delete') or
    has_table_privilege('service_role','public.proofolio_runs','delete') then
    raise exception 'Service role has unrestricted deletion or rewrite permission';
  end if;
end;
$$;
rollback;
