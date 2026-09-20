-- 007: AI answer scores for recruiting submissions. Additive; apply after 006.
begin;

create table public.proofolio_submission_scores (
  submission_id uuid primary key references public.proofolio_submissions(id) on delete cascade,
  state text not null check (state in ('pending','running','complete','failed')),
  model text check (model is null or length(model) between 1 and 120),
  overall_score smallint check (overall_score is null or overall_score between 0 and 100),
  items jsonb not null default '[]'::jsonb check (jsonb_typeof(items)='array'),
  error text check (error is null or length(error) <= 400),
  cost_usd numeric(10,6) check (cost_usd is null or cost_usd >= 0),
  scored_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint proofolio_submission_scores_complete check (state <> 'complete' or (overall_score is not null and scored_at is not null))
);
alter table public.proofolio_submission_scores enable row level security;
revoke all on public.proofolio_submission_scores from public, anon, authenticated;
grant select, insert, update on public.proofolio_submission_scores to service_role;

-- Owner-scoped upsert. The server passes the candidate's member id; a completed submission is required.
create function public.proofolio_save_submission_score(p_submission_id uuid, p_user_id text, p_score jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.proofolio_submissions; v_state text; v_items jsonb; v_overall smallint; v_cost numeric;
begin
  select * into s from public.proofolio_submissions where id=p_submission_id and user_id=p_user_id for update;
  if not found or s.completed_at is null or s.run_id is null then raise exception 'Completed owned submission required'; end if;
  if jsonb_typeof(p_score) is distinct from 'object' then raise exception 'Score object required'; end if;
  v_state := p_score->>'state';
  if v_state not in ('pending','running','complete','failed') then raise exception 'Invalid state'; end if;
  v_items := coalesce(p_score->'items','[]'::jsonb);
  if jsonb_typeof(v_items) <> 'array' or jsonb_array_length(v_items) > 20 then raise exception 'Invalid items'; end if;
  v_overall := case when p_score ? 'overallScore' and jsonb_typeof(p_score->'overallScore')='number' then (p_score->>'overallScore')::smallint else null end;
  v_cost := case when jsonb_typeof(p_score->'costUsd')='number' then (p_score->>'costUsd')::numeric else null end;
  if v_state='complete' and (v_overall is null or v_overall<0 or v_overall>100) then raise exception 'Overall score required'; end if;
  insert into public.proofolio_submission_scores(submission_id,state,model,overall_score,items,error,cost_usd,scored_at,updated_at)
    values(p_submission_id,v_state,left(p_score->>'model',120),v_overall,v_items,left(p_score->>'error',400),v_cost,
      case when v_state='complete' then now() else null end,now())
  on conflict (submission_id) do update set state=excluded.state,model=excluded.model,overall_score=excluded.overall_score,
    items=excluded.items,error=excluded.error,cost_usd=excluded.cost_usd,scored_at=excluded.scored_at,updated_at=now();
  return p_submission_id;
end;
$$;
revoke all on function public.proofolio_save_submission_score(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.proofolio_save_submission_score(uuid,text,jsonb) to service_role;

-- Same columns in the same order, plus scoring aggregates at the end.
create or replace view public.proofolio_test_summaries with (security_invoker=true) as
select t.*,
  (select count(*) from public.proofolio_submissions s where s.test_id=t.id and s.expires_at>now()) as submission_count,
  (select count(*) from public.proofolio_submissions s where s.test_id=t.id and s.expires_at>now() and s.completed_at is not null) as completed_count,
  (select count(*) from public.proofolio_submissions s join public.proofolio_submission_scores c on c.submission_id=s.id
    where s.test_id=t.id and s.expires_at>now() and c.state='complete') as scored_count,
  (select round(avg(c.overall_score)) from public.proofolio_submissions s join public.proofolio_submission_scores c on c.submission_id=s.id
    where s.test_id=t.id and s.expires_at>now() and c.state='complete') as average_score
from public.proofolio_tests t;
revoke all on public.proofolio_test_summaries from public,anon,authenticated;
grant select on public.proofolio_test_summaries to service_role;

notify pgrst, 'reload schema';
commit;
