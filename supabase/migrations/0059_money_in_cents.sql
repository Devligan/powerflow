-- =====================================================================
-- 0059 — Money is stated in cents
--
-- A position's P&L is MW x (mark - entry), and a mark averages four
-- 15-minute prices, so it has four decimals; the collateral rate came out of
-- percentile_cont, a double, and carried float noise (32.8184999999999).
-- Every figure was exact, and each was rounded to the cent on its own for
-- display, so they did not add up: Total P&L -$186.08 beside Equity
-- $99,813.93 on a $100,000 account (#66).
--
-- A settlement statement is in cents per line, and its totals are the sums of
-- those lines. So, from here:
--
--   1. The collateral rate is in cents per MW, rounded up: a rate is never
--      understated.
--   2. Each open bid and margined position holds its MW x rate rounded up to
--      the cent; the account holds their sum (account_credit), and a new bid
--      is checked against what is left on the same terms (place_limit_order).
--   3. A margined position's P&L is booked in cents when it is realized, at a
--      close (execute_trade) or at settlement (settle_delivered_positions),
--      rounded half away from zero; cash moves by exactly that amount.
--   4. Its mark-to-market is stated the same way, line by line, wherever
--      equity is summed (account_margin, get_leaderboard), so settling at the
--      mark is still equity-neutral to the cent.
--
-- Cash, deficit and realized P&L on production are already whole cents (the
-- desk only trades margined instruments, and 0056 reset the books), so no
-- stored value changes. The retired cash-settled instruments are untouched.
-- =====================================================================

-- 1. The rate. Rounded to six places first, so float noise just above a
--    whole cent (25.700000000001) does not round up a cent.
create or replace function public.bid_exposure_factor(p_market_id uuid)
returns numeric
language sql
stable
set search_path = public
as $$
  select ceil(round(greatest(
    10,
    coalesce(percentile_cont(0.95) within group (order by abs(rt.price - da.price)), 0)
  )::numeric, 6) * 100) / 100
  from public.market_prices da
  join public.market_prices rt
    on rt.market_id = da.market_id
   and rt.delivery_timestamp = da.delivery_timestamp
   and rt.product = 'RTM_HOURLY'
   and rt.is_final
  where da.market_id = p_market_id
    and da.product = 'DAM_HOURLY'
    and da.delivery_timestamp > now() - interval '30 days'
$$;

-- 2. What the account holds, line by line in cents. The rate is read once per
--    point, as before.
create or replace function public.account_credit(p_user_id uuid)
returns table (
  credit_limit numeric,
  bid_collateral numeric,
  position_collateral numeric,
  available_credit numeric,
  open_bids bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and not public.acts_for(p_user_id) then
    raise exception 'FORBIDDEN';
  end if;

  return query
  with rates as (
    select x.market_id, public.bid_exposure_factor(x.market_id) as rate
    from (select o.market_id from public.paper_orders o
          where o.user_id = p_user_id and o.status = 'OPEN'
          union
          select pos.market_id from public.positions pos
          where pos.user_id = p_user_id and pos.quantity_mwh <> 0) x
  ),
  bids as (
    select coalesce(sum(ceil(o.quantity_mwh * r.rate * 100) / 100), 0) as held,
           count(*)::bigint as n
    from public.paper_orders o
    join rates r on r.market_id = o.market_id
    where o.user_id = p_user_id and o.status = 'OPEN'
  ),
  margined as (
    select coalesce(sum(ceil(abs(pos.quantity_mwh) * r.rate * 100) / 100), 0) as held
    from public.positions pos
    join rates r on r.market_id = pos.market_id
    where pos.user_id = p_user_id and pos.quantity_mwh <> 0
      and public.is_margined_instrument(pos.instrument)
  ),
  lim as (
    -- 0043: an open loss or a deficit is already owed; a gain is not cash yet.
    select least(ac.cash_balance, (select mg.equity from public.account_margin(p_user_id) mg)) as v
    from public.paper_accounts ac
    where ac.user_id = p_user_id
  )
  select lim.v, bids.held, margined.held, lim.v - bids.held - margined.held, bids.n
  from lim, bids, margined;
end;
$$;

comment on function public.account_credit(uuid) is
  'Credit limit (cash, less any open loss or deficit), collateral held by open bids and margined positions (each MW x rate, rounded up to the cent), and what is left for a new bid. place_limit_order refuses a bid whose collateral exceeds available_credit. Migrations 0058, 0059.';

-- 3-4. The engine functions, patched in place. Each anchor must be found
--      exactly once, so a definition that drifted fails here, not silently.
create function pg_temp.patch(p_def text, p_old text, p_new text, p_what text)
returns text
language plpgsql
as $$
begin
  if (length(p_def) - length(replace(p_def, p_old, ''))) / length(p_old) <> 1 then
    raise exception '0059: % not found exactly once', p_what;
  end if;
  return replace(p_def, p_old, p_new);
end;
$$;

do $$
declare
  v_def text;
begin
  -- The credit check: this bid's collateral, rounded up to the cent.
  v_def := pg_get_functiondef('public.place_limit_order(uuid, uuid, text, text, uuid, text, numeric, numeric, timestamptz, timestamptz, timestamptz, text)'::regprocedure);
  v_def := pg_temp.patch(v_def,
    'if p_quantity_mwh * public.bid_exposure_factor(p_market_id)',
    'if ceil(p_quantity_mwh * public.bid_exposure_factor(p_market_id) * 100) / 100',
    'place_limit_order credit check');
  execute v_def;

  -- A close realizes P&L in cents.
  v_def := pg_get_functiondef('public.execute_trade(uuid, uuid, uuid, text, text, text, numeric, timestamptz, timestamptz, text, timestamptz)'::regprocedure);
  v_def := pg_temp.patch(v_def,
    '  -- 10. Cash moves with the trade. A margined position (0041) is backed by',
    E'  -- 0059: a margined position\'s P&L is booked in cents.\n'
    || E'  if public.is_margined_instrument(v_instr.code) then\n'
    || E'    v_realized_delta := round(v_realized_delta, 2);\n'
    || E'  end if;\n\n'
    || '  -- 10. Cash moves with the trade. A margined position (0041) is backed by',
    'execute_trade step 10');
  execute v_def;

  -- So does settlement, and cash moves by the same amount.
  v_def := pg_get_functiondef('public.settle_delivered_positions(timestamptz, integer, uuid)'::regprocedure);
  v_def := pg_temp.patch(v_def,
    'then (v_price - v_pos.average_entry_price) * v_pos.quantity_mwh',
    'then round((v_price - v_pos.average_entry_price) * v_pos.quantity_mwh, 2)',
    'settle_delivered_positions notional');
  v_def := pg_temp.patch(v_def,
    'v_realized := (v_price - v_pos.average_entry_price) * v_pos.quantity_mwh;',
    'v_realized := case when public.is_margined_instrument(v_pos.instrument)'
    || ' then round((v_price - v_pos.average_entry_price) * v_pos.quantity_mwh, 2)'
    || ' else (v_price - v_pos.average_entry_price) * v_pos.quantity_mwh end;',
    'settle_delivered_positions realized');
  execute v_def;

  -- Marked value, line by line in cents, on the Desk ...
  v_def := pg_get_functiondef('public.account_margin(uuid)'::regprocedure);
  v_def := pg_temp.patch(v_def,
    'sum(p.quantity_mwh * (m.mark - case when public.is_margined_instrument(p.instrument)',
    'sum(round(p.quantity_mwh * (m.mark - case when public.is_margined_instrument(p.instrument)',
    'account_margin marked value');
  v_def := pg_temp.patch(v_def,
    'then p.average_entry_price else 0 end))',
    'then p.average_entry_price else 0 end), 2))',
    'account_margin marked value close');
  execute v_def;

  -- ... and on the standings.
  v_def := pg_get_functiondef('public.get_leaderboard(integer)'::regprocedure);
  v_def := pg_temp.patch(v_def,
    'sum(pos.quantity_mwh * (mark.mark_price - case when public.is_margined_instrument(pos.instrument)',
    'sum(round(pos.quantity_mwh * (mark.mark_price - case when public.is_margined_instrument(pos.instrument)',
    'get_leaderboard marked value');
  v_def := pg_temp.patch(v_def,
    'then pos.average_entry_price else 0 end)) as marked_value',
    'then pos.average_entry_price else 0 end), 2)) as marked_value',
    'get_leaderboard marked value close');
  execute v_def;
end
$$;

drop function pg_temp.patch(text, text, text, text);

-- Nothing stored needs converting: say so, or stop.
do $$
declare
  v_accounts int;
  v_positions int;
begin
  select count(*) into v_accounts from public.paper_accounts
  where cash_balance <> round(cash_balance, 2) or deficit <> round(deficit, 2);
  select count(*) into v_positions from public.positions p
  where p.realized_pnl <> round(p.realized_pnl, 2) and public.is_margined_instrument(p.instrument);
  raise notice '0059: % account(s), % margined position(s) holding fractions of a cent', v_accounts, v_positions;
end
$$;
