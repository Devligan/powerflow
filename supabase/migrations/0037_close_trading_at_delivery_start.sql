-- =====================================================================
-- 0037 — Trading closes when delivery STARTS, not when it ends
--
-- Since 0006 the engine refused an order only once its delivery window had
-- ENDED (p_delivery_end <= clock). For the whole of a delivery hour it still
-- accepted a fill at the hour's day-ahead price — while ERCOT was already
-- publishing that hour's 15-minute real-time prints (about 2 minutes after
-- each interval; the ingest lands them about a minute later). A convergence
-- trade (virtual, DART, DA→RT congestion) placed at :50 settles on an
-- average that is three-quarters known: a near-riskless bet. Confirmed on
-- the live engine on 2026-11-01 (a VIRTUAL for the hour in progress was
-- accepted with two of its four RT prints published). No executed trade had
-- used it: every fill to date was placed before its delivery started.
--
-- The rule is now the same everywhere a position can be opened:
--   1. execute_trade      — refuses p_delivery_start <= the account's clock.
--   2. place_limit_order  — the same, so no order rests into a live period.
--   3. fill_crossing_limit_orders — only considers orders whose delivery has
--      not started, and expires the ones whose delivery has.
-- Settlement and margin are untouched (they never open positions here).
--
-- The function bodies are patched in place, as 0028 did, so the rest of each
-- definition stays exactly what is deployed. Each patch is checked: a body
-- that no longer contains the expected text fails the migration instead of
-- silently doing nothing, and a re-run (already patched) is a no-op.
-- =====================================================================

do $$
declare
  r record;
  v_def text;
  v_new text;
begin
  for r in
    select * from (values
      ('public.execute_trade(uuid,uuid,uuid,text,text,text,numeric,timestamptz,timestamptz,text)'::regprocedure,
       'if p_delivery_end <= v_as_of then',
       'if p_delivery_start <= v_as_of then'),
      ('public.place_limit_order(uuid,uuid,text,text,uuid,text,numeric,numeric,timestamptz,timestamptz,timestamptz)'::regprocedure,
       'if p_delivery_end <= v_as_of then',
       'if p_delivery_start <= v_as_of then'),
      ('public.fill_crossing_limit_orders(integer)'::regprocedure,
       'where status = ''OPEN'' and expires_at <= v_now;',
       'where status = ''OPEN'' and (expires_at <= v_now or delivery_start <= v_now);'),
      ('public.fill_crossing_limit_orders(integer)'::regprocedure,
       'and delivery_end > v_now',
       'and delivery_start > v_now')
    ) as t(fn, old_text, new_text)
  loop
    v_def := pg_get_functiondef(r.fn);
    if position(r.new_text in v_def) > 0 then
      continue; -- already patched
    end if;
    if position(r.old_text in v_def) = 0 then
      raise exception '0037: expected text not found in %: %', r.fn, r.old_text;
    end if;
    v_new := replace(v_def, r.old_text, r.new_text);
    execute v_new;
  end loop;
end
$$;
