-- Optional: run AFTER migration in SQL Editor. Synthetic records roll back, including on failure.
begin;
set local role service_role;
do $$
<<checks>>
declare
  run_id uuid := gen_random_uuid();
  user_id text := repeat('a', 64);
  payload jsonb;
  answers jsonb;
  saved integer;
begin
  payload := jsonb_build_object('id',run_id,'user_id',user_id,'track','design','file_name','SYNTHETIC-TEST.pdf',
    'pdf_sha256',repeat('b',64),'requested_question_count',10,'state','running','started_at','2026-09-20T00:00:00Z');
  perform public.proofolio_sync_run(payload);
  payload := payload || jsonb_build_object('state','complete','finished_at','2026-09-20T00:00:01Z',
    'result',jsonb_build_object('status','needs_review','maxQuestions',10,'questions',jsonb_build_array(
      jsonb_build_object('id','q7','prompt','작업을 설명해주세요.','pages',jsonb_build_array(1)),
      jsonb_build_object('id','q9','prompt','선택 기준을 설명해주세요.','pages',jsonb_build_array(2)))));
  perform public.proofolio_sync_run(payload);
  perform public.proofolio_sync_run(payload);
  if (select generated_question_count from public.proofolio_admin_runs where proofolio_admin_runs.run_id = checks.run_id) <> 2 then
    raise exception 'Generated count must be 2, not requested 10';
  end if;
  answers := jsonb_build_array(jsonb_build_object('questionId','q7','answer','합성 답변','seconds',3),
    jsonb_build_object('questionId','q9','answer','','seconds',40));
  saved := public.proofolio_save_answers(run_id,user_id,answers);
  if saved <> 2 then raise exception 'Wrong saved count'; end if;
  perform public.proofolio_save_answers(run_id,user_id,answers);
  if (select count(*) from public.proofolio_admin_answers a where a.run_id = checks.run_id and a.answer is not null) <> 2 then
    raise exception 'Missing or duplicate answers';
  end if;
  begin
    perform public.proofolio_save_answers(run_id,repeat('c',64),answers);
    raise exception 'Cross-user access allowed';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.proofolio_save_answers(run_id,user_id,jsonb_set(answers,'{0,answer}','"changed"'));
    raise exception 'Overwrite allowed';
  exception when unique_violation then null; end;
  begin
    perform public.proofolio_save_answers(run_id,user_id,jsonb_set(answers,'{0,questionId}','"unknown"'));
    raise exception 'Unknown question allowed';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.proofolio_save_answers(run_id,user_id,jsonb_build_array(answers->0,answers->0));
    raise exception 'Duplicate ID allowed';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.proofolio_sync_run(jsonb_set(payload,'{result,questions,0,prompt}','"changed"'));
    raise exception 'Question overwrite allowed';
  exception when unique_violation then null; end;
end;
$$;
reset role;

do $$
declare
  role_name text;
  relation_name text;
begin
  foreach role_name in array array['anon','authenticated'] loop
    foreach relation_name in array array['proofolio_users','proofolio_runs','proofolio_questions','proofolio_answers','proofolio_admin_runs','proofolio_admin_answers'] loop
      if has_table_privilege(role_name, 'public.' || relation_name, 'select,insert,update,delete') then
        raise exception 'Unexpected client table access: % %', role_name, relation_name;
      end if;
    end loop;
    if has_function_privilege(role_name,'public.proofolio_sync_run(jsonb)','execute') or
      has_function_privilege(role_name,'public.proofolio_save_answers(uuid,text,jsonb)','execute') then
      raise exception 'Unexpected client RPC access: %',role_name;
    end if;
  end loop;
  if has_table_privilege('service_role','public.proofolio_answers','update,delete') or
    has_table_privilege('service_role','public.proofolio_questions','update,delete') then
    raise exception 'Service role cannot rewrite questions/answers';
  end if;
  if (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname in ('proofolio_users','proofolio_runs','proofolio_questions','proofolio_answers') and c.relrowsecurity) <> 4 then
    raise exception 'Missing RLS';
  end if;
end;
$$;
rollback;
