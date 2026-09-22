-- =====================================================================
-- PowerFlow — public leaderboard (Phase 4)
--
-- Aggregated, opt-in only. SECURITY DEFINER so the aggregation bypasses
-- RLS of the private base tables, but it only ever exposes rows whose
-- owner has leaderboard_opt_in = true. Clients receive equity-like
-- aggregates, never trade details.
-- =====================================================================

create or replace function public.get_leaderboard(p_top int default 100)
returns table (
  user_id uuid,
  username text,
  display_name text,
  starting_cash numeric,
  cash_balance numeric,
  realized_pnl numeric,
  marked_value numeric,
  equity numeric,
  return_bps numeric,
  open_notional_mwh numeric,
  positions_count bigint,
  trades_count bigint,
  joined_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with latest_price as (
    select distinct on (mp.market_id) mp.market_id, mp.price
    from public.market_prices mp
    order by mp.market_id, mp.delivery_timestamp desc
  ),
  marked as (
    select pos.user_id,
           sum(lp.price * abs(pos.quantity_mwh)) as marked_value,
           sum(abs(pos.quantity_mwh)) as open_notional_mwh,
           count(*) as positions_count
    from public.positions pos
    join latest_price lp on lp.market_id = pos.market_id
    where pos.quantity_mwh <> 0
    group by pos.user_id
  ),
  closed as (
    select pos.user_id, sum(pos.realized_pnl) as realized_pnl
    from public.positions pos
    group by pos.user_id
  ),
  trades as (
    select tr.user_id, count(*) as trades_count
    from public.trades tr
    group by tr.user_id
  )
  select
    pr.id,
    pr.username,
    pr.display_name,
    ac.starting_cash,
    ac.cash_balance,
    coalesce(cl.realized_pnl, 0),
    coalesce(mk.marked_value, 0),
    ac.cash_balance + coalesce(mk.marked_value, 0),
    case when ac.starting_cash > 0 then
      ((ac.cash_balance + coalesce(mk.marked_value, 0) - ac.starting_cash)
        / ac.starting_cash) * 10000
    else 0 end,
    coalesce(mk.open_notional_mwh, 0),
    coalesce(mk.positions_count, 0),
    coalesce(tr.trades_count, 0),
    pr.created_at
  from public.profiles pr
  join public.paper_accounts ac on ac.user_id = pr.id
  left join closed cl on cl.user_id = pr.id
  left join marked mk on mk.user_id = pr.id
  left join trades tr on tr.user_id = pr.id
  where pr.leaderboard_opt_in
  order by 8 desc
  limit greatest(1, least(p_top, 500))
$$;

grant execute on function public.get_leaderboard(int) to anon, authenticated;