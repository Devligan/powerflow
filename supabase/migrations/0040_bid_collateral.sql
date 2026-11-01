-- =====================================================================
-- 0040 — Bids need collateral, sized the way ERCOT sizes it
--
-- ERCOT does not limit a trader's virtual bids by their notional value: it
-- holds collateral against their potential exposure — roughly bid MW times
-- a high percentile of the price move the bid could lose, re-estimated from
-- recent history (the DAM "e" factors). PowerFlow's only check was a flat
-- $500k gross-notional cap at fill time, so an account could stack any
-- number of resting bids it could never cover.
--
-- bid_exposure_factor(market): $/MW of exposure for one hour at a point =
-- the 95th percentile of |RT − DA| over the last 30 days of final prices
-- there, never below $10/MW. place_limit_order now refuses a bid when the
-- collateral of every open bid plus this one would exceed the account's
-- cash (CREDIT_LIMIT_EXCEEDED). A path is sized on its source point.
-- Fills, accounting and settlement are unchanged.
-- =====================================================================

create or replace function public.bid_exposure_factor(p_market_id uuid)
returns numeric
language sql
stable
set search_path = public
as $$
  select greatest(
    10,
    coalesce(percentile_cont(0.95) within group (order by abs(rt.price - da.price)), 0)
  )::numeric
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

revoke execute on function public.bid_exposure_factor(uuid) from public, anon;
grant execute on function public.bid_exposure_factor(uuid) to authenticated, service_role;

do $$
declare
  v_fn regprocedure :=
    'public.place_limit_order(uuid,uuid,text,text,uuid,text,numeric,numeric,timestamptz,timestamptz,timestamptz)'::regprocedure;
  v_def text := pg_get_functiondef(v_fn);
  v_anchor text := E'  -- Expiry: bounded so a forgotten order cannot live forever.';
  v_check text :=
       E'  -- 0040: collateral. Every open bid, and this one, holds MW x the point''s\n'
    || E'  -- exposure factor; together they must fit within the account''s cash.\n'
    || E'  if (select coalesce(sum(x.q * public.bid_exposure_factor(x.m)), 0)\n'
    || E'      from (select market_id m, sum(quantity_mwh) q\n'
    || E'            from public.paper_orders\n'
    || E'            where user_id = p_user_id and status = ''OPEN''\n'
    || E'            group by market_id) x)\n'
    || E'     + p_quantity_mwh * public.bid_exposure_factor(p_market_id)\n'
    || E'     > (select cash_balance from public.paper_accounts where user_id = p_user_id) then\n'
    || E'    raise exception ''CREDIT_LIMIT_EXCEEDED'';\n'
    || E'  end if;\n\n';
begin
  if position('CREDIT_LIMIT_EXCEEDED' in v_def) > 0 then
    return; -- already applied
  end if;
  if position(v_anchor in v_def) = 0 then
    raise exception '0040: place_limit_order expiry anchor not found';
  end if;
  execute replace(v_def, v_anchor, v_check || v_anchor);
end
$$;
