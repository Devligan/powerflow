-- =====================================================================
-- 0039 — Bids at ERCOT's price bounds (negative prices included), and
--        PTP options retired
--
--   1. Limit prices. 0026 required limit_price > 0, so a bid could not be
--      priced below zero — but ERCOT clears negative routinely (West, the
--      Panhandle and North hubs print below zero in several percent of
--      hours when wind and solar overwhelm export capacity), and an INC
--      offer at -$5 or a DEC bid capped at $0 is ordinary trading. ERCOT's
--      bid/offer bounds are -$250/MWh to the $5,000/MWh system-wide offer
--      cap; the order book now takes exactly that range.
--
--   2. PTP_OPTION is no longer tradable. In ERCOT's day-ahead market PTP
--      options are available to NOIEs (municipal and co-op utilities), not to
--      a QSE without assets; and as priced here an option entered at
--      max(DA spread, 0) — $0 whenever the day-ahead spread was negative —
--      bought real-time congestion upside for nothing. Positions already held
--      settle as before; open orders in it are expired.
-- =====================================================================

-- 1. Bounds ------------------------------------------------------------
alter table public.paper_orders drop constraint if exists paper_orders_limit_price_check;
alter table public.paper_orders
  add constraint paper_orders_limit_price_check
  check (limit_price is null or (limit_price >= -250 and limit_price <= 5000));

do $$
declare
  v_fn regprocedure :=
    'public.place_limit_order(uuid,uuid,text,text,uuid,text,numeric,numeric,timestamptz,timestamptz,timestamptz)'::regprocedure;
  v_def text := pg_get_functiondef(v_fn);
  v_old text := 'if p_limit_price is not null and p_limit_price <= 0 then';
  v_new text := 'if p_limit_price is not null and (p_limit_price < -250 or p_limit_price > 5000) then';
begin
  if position(v_new in v_def) > 0 then
    return; -- already applied
  end if;
  if position(v_old in v_def) = 0 then
    raise exception '0039: place_limit_order limit check not found';
  end if;
  execute replace(v_def, v_old, v_new);
end
$$;

-- 2. PTP options --------------------------------------------------------
update public.instruments set tradable = false where code = 'PTP_OPTION';

update public.paper_orders
set status = 'EXPIRED', updated_at = now()
where status = 'OPEN' and instrument = 'PTP_OPTION';
