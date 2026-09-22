-- =====================================================================
-- 0011 — Strict (exact-interval) pricing
--
-- 0008's `price_at` fell back to "the most recently published price in the
-- series" whenever the requested delivery interval had no row. Combined with
-- a 35-day delivery window and a feed that publishes ~72 hours ahead, that
-- meant an order could be filled at a price from an unrelated interval, days
-- away, with nothing in the trade row saying so:
--
--   requested delivery   2026-10-15 18:00
--   price actually used  2026-09-24 15:00   (source row of market_price_id)
--   trades.price_timestamp recorded 2026-10-15 18:00  ← the *requested* hour
--
-- So `price_timestamp` claimed a price existed for an interval that had none,
-- and the position was opened at a 21-day-old price. `price_stale` was set,
-- but nothing rejected on it and the UI showed an ordinary fill.
--
-- `price_average` had the same shape of bug in the other direction: it
-- averaged whatever rows happened to fall in the window, so a half-covered
-- block-forward window silently priced off the covered half.
--
-- Resolution, chosen as the unambiguous option: an instrument is priced only
-- from prices that exist for the intervals it settles. POINT/DIFFERENCE/
-- CONVERGENCE require the exact interval; AVERAGE requires the window to be
-- complete. Anything else is PRICE_UNAVAILABLE and no fill happens. The
-- consequence is that `price_at` is now exact by construction, so
-- `trades.price_timestamp` is the interval the price really came from, and
-- `price_stale` can no longer be true on an executed trade.
--
-- To trade, the feed has to have published the interval — which is the honest
-- rule, and the reason ingestion matters (see 0009/0012).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Exact-interval price lookup. NULL means "no price for this interval".
-- ---------------------------------------------------------------------
create or replace function public.price_at(
  p_market_id uuid,
  p_product text,
  p_ts timestamptz
)
returns numeric
language sql
stable
set search_path = public
as $$
  -- The unique key (market_id, delivery_timestamp, product) makes this at most
  -- one row, so there is nothing to prefer between duplicates.
  select mp.price
  from public.market_prices mp
  where mp.market_id = p_market_id
    and mp.product = p_product
    and mp.delivery_timestamp = p_ts
$$;

-- The price row behind price_at, for trade provenance. Same rule, so a trade's
-- `market_price_id` always points at a row for its own delivery interval.
create or replace function public.price_row_id(
  p_market_id uuid,
  p_product text,
  p_ts timestamptz
)
returns uuid
language sql
stable
set search_path = public
as $$
  select mp.id
  from public.market_prices mp
  where mp.market_id = p_market_id
    and mp.product = p_product
    and mp.delivery_timestamp = p_ts
$$;

-- The delivery interval a mark is taken from. With exact pricing the price is
-- either from the requested interval or there is none.
create or replace function public.price_as_of(
  p_market_id uuid,
  p_product text,
  p_ts timestamptz
)
returns timestamptz
language sql
stable
set search_path = public
as $$
  select mp.delivery_timestamp
  from public.market_prices mp
  where mp.market_id = p_market_id
    and mp.product = p_product
    and mp.delivery_timestamp = p_ts
$$;

-- Whether no price exists for an interval. Under strict pricing this is true
-- exactly when price_at returns NULL, so a fill can never be both priced and
-- stale; it is kept on the trade row as an invariant that must stay false.
create or replace function public.price_is_stale(
  p_market_id uuid,
  p_product text,
  p_ts timestamptz
)
returns boolean
language sql
stable
set search_path = public
as $$
  select not exists (
    select 1 from public.market_prices mp
    where mp.market_id = p_market_id
      and mp.product = p_product
      and mp.delivery_timestamp = p_ts
  );
$$;

-- ---------------------------------------------------------------------
-- Window average, only when the window is fully priced.
-- ---------------------------------------------------------------------
-- A partially-covered window used to average the covered part and report it as
-- the window price, which is a wrong number rather than a missing one. The
-- expected count comes from the product's own interval length, and the row
-- count is exact because (market_id, delivery_timestamp, product) is unique.
create or replace function public.price_average(
  p_market_id uuid,
  p_product text,
  p_from timestamptz,
  p_to timestamptz
)
returns numeric
language plpgsql
stable
set search_path = public
as $$
declare
  v_interval_minutes int;
  v_expected int;
  v_rows int;
  v_avg numeric;
begin
  select p.interval_minutes into v_interval_minutes
  from public.products p
  where p.code = p_product;
  if v_interval_minutes is null or v_interval_minutes <= 0 then
    return null;
  end if;

  v_expected :=
    (extract(epoch from (p_to - p_from)) / 60 / v_interval_minutes)::int;
  if v_expected <= 0 then
    return null;
  end if;

  select count(*), avg(mp.price)
    into v_rows, v_avg
  from public.market_prices mp
  where mp.market_id = p_market_id
    and mp.product = p_product
    and mp.delivery_timestamp >= p_from
    and mp.delivery_timestamp < p_to;

  if v_rows <> v_expected then
    return null; -- incomplete window: not a price, rather than a wrong one
  end if;

  return v_avg;
end;
$$;

revoke execute on function public.price_at(uuid, text, timestamptz) from public;
revoke execute on function public.price_row_id(uuid, text, timestamptz) from public;
revoke execute on function public.price_as_of(uuid, text, timestamptz) from public;
revoke execute on function public.price_is_stale(uuid, text, timestamptz) from public;
revoke execute on function public.price_average(uuid, text, timestamptz, timestamptz) from public;

grant execute on function public.price_at(uuid, text, timestamptz) to authenticated, service_role;
grant execute on function public.price_row_id(uuid, text, timestamptz) to authenticated, service_role;
grant execute on function public.price_as_of(uuid, text, timestamptz) to authenticated, service_role;
grant execute on function public.price_is_stale(uuid, text, timestamptz) to authenticated, service_role;
grant execute on function public.price_average(uuid, text, timestamptz, timestamptz) to authenticated, service_role;
