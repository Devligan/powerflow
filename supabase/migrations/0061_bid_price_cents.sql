-- =====================================================================
-- 0061 — Bid prices in whole cents
--
-- place_limit_order took a limit price to six decimal places, so $35.123456
-- was stored and shown as a bid. ERCOT takes day-ahead bid and offer prices
-- in cents per MWh, as it takes quantities in steps of 0.1 MW (0045).
--
-- From here a limit price off the cent is refused (PRICE_INCREMENT), in the
-- engine, so a direct RPC call is held to it too. A fill is always at the
-- clearing price, never the limit, so an order already open at a sub-cent
-- limit fills as it would have and is left as it is.
-- =====================================================================

do $$
declare
  v_def text;
  v_old constant text := E'    raise exception ''LIMIT_PRICE_INVALID'';\n  end if;\n';
begin
  v_def := pg_get_functiondef('public.place_limit_order(uuid, uuid, text, text, uuid, text, numeric, numeric, timestamptz, timestamptz, timestamptz, text)'::regprocedure);
  if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
    raise exception '0061: place_limit_order price check not found exactly once';
  end if;
  execute replace(v_def, v_old,
    v_old
    || E'  -- 0061: ERCOT takes bid prices in cents per MWh.\n'
    || E'  if p_limit_price is not null and p_limit_price <> round(p_limit_price, 2) then\n'
    || E'    raise exception ''PRICE_INCREMENT'';\n'
    || E'  end if;\n');
end
$$;

do $$
declare
  v_open int;
begin
  select count(*) into v_open from public.paper_orders
  where status = 'OPEN' and limit_price is not null and limit_price <> round(limit_price, 2);
  raise notice '0061: % open order(s) have a limit price off the cent', v_open;
end
$$;
