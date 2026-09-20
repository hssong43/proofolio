-- Operator audit for an explicitly approved spending window. Does not fund it.
begin;
alter table public.proofolio_execution_budget add column approval jsonb;
create function public.proofolio_close_execution_budget() returns void
language sql security definer set search_path='' as $$
  update public.proofolio_execution_budget set blocked=true where id;
$$;
revoke all on function public.proofolio_close_execution_budget() from public,anon,authenticated;
grant execute on function public.proofolio_close_execution_budget() to service_role;
notify pgrst, 'reload schema';
commit;
