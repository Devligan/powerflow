-- =====================================================================
-- 0053 — A trader's live account is always live
--
-- Until now any account could move its clock into the past (0020) and bid
-- the days it had already seen: replay fills and settles against the same
-- cash as live trading, so practice moved the trader's real balance. 0042
-- only took such an account off the standings (replay_tainted_at); its
-- balance still carried the replay.
--
-- Since 0048 replay has its own accounts: the practice desk and challenge
-- desks, each with its own $100,000 and clock. So the rule is now simply
-- that only a desk's clock may stand anywhere but live:
--
--   1. live_account_stays_live: a trigger on paper_accounts refuses a
--      nonzero sim_clock_offset for any account that is not a desk. It holds
--      for every path — set_sim_clock from a session, the service role,
--      enter_challenge, anything later — because it guards the column rather
--      than each function. set_sim_clock surfaces it as LIVE_ACCOUNT_IS_LIVE.
--   2. Live accounts left in replay go back to live. Their open bids for
--      days whose day-ahead gate has already passed could only ever fill at
--      prices the trader had seen, so they are cancelled (audited as
--      ORDER_CANCELLED with the reason); bids for days still ahead stay, as
--      the live bids they now are. Positions already filled in replay settle
--      on ERCOT's final prices like any other — trades are immutable (0016) —
--      and the account stays off the standings as 0042 left it.
-- =====================================================================

create or replace function public.live_account_stays_live()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.sim_clock_offset <> 0
     and not exists (select 1 from public.desks d where d.desk_user_id = new.user_id) then
    raise exception 'LIVE_ACCOUNT_IS_LIVE';
  end if;
  return new;
end;
$$;

revoke execute on function public.live_account_stays_live() from public, anon, authenticated;

-- 2, before the trigger exists: bring every live account back to live.
do $$
declare
  v_accounts uuid[];
begin
  select coalesce(array_agg(a.user_id), '{}') into v_accounts
  from public.paper_accounts a
  where a.sim_clock_offset <> 0
    and not exists (select 1 from public.desks d where d.desk_user_id = a.user_id);

  with cancelled as (
    update public.paper_orders o
       set status = 'CANCELLED', updated_at = now()
     where o.user_id = any (v_accounts)
       and o.status = 'OPEN'
       and public.dam_gate(o.delivery_start) <= now()
    returning o.id, o.user_id
  )
  insert into public.audit_events (user_id, event_type, entity_type, entity_id, metadata)
  select c.user_id, 'ORDER_CANCELLED', 'paper_order', c.id,
         jsonb_build_object('reason', 'LIVE_ACCOUNT_RETURNED_TO_LIVE', 'migration', '0053')
  from cancelled c;

  insert into public.audit_events (user_id, event_type, entity_type, entity_id, metadata)
  select a.user_id, 'SIM_CLOCK_CHANGED', 'paper_account', null,
         jsonb_build_object('to', null, 'offset_ns', 0, 'from_offset_ns', a.sim_clock_offset,
                            'reason', 'LIVE_ACCOUNT_RETURNED_TO_LIVE', 'migration', '0053')
  from public.paper_accounts a
  where a.user_id = any (v_accounts);

  update public.paper_accounts
     set sim_clock_offset = 0
   where user_id = any (v_accounts);

  raise notice '0053: % live account(s) returned to live', cardinality(v_accounts);
end
$$;

drop trigger if exists live_account_stays_live on public.paper_accounts;
create trigger live_account_stays_live
  before insert or update of sim_clock_offset on public.paper_accounts
  for each row execute function public.live_account_stays_live();

comment on function public.live_account_stays_live() is
  'Only a desk (0048: practice, challenge) may run a displaced clock; a trader''s live account trades the live market. Migration 0053.';
