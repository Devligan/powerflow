-- =====================================================================
-- 0060 — An order cannot outlive its delivery
--
-- place_limit_order took an explicit expiry as given, so an order sent with
-- expiresAt 2099 was stored and shown with it (#73). Nothing could fill late
-- because of it: the sweep ends an order at least(expires_at, delivery_start),
-- and a day-ahead bid is in the market only until its operating hour starts.
-- But the stored expiry then misstated when the order leaves the book.
--
-- From here an expiry must be in the future and no later than delivery start,
-- or the order is refused (EXPIRY_INVALID). Left out, it is delivery start,
-- as before. Checked in the engine, so a direct RPC call is held to it too.
--
-- Production has no open order past this bound (one cancelled order is, and
-- a cancelled order's record stays as it was).
-- =====================================================================

do $$
declare
  v_def text;
  v_old constant text := 'if v_expiry <= v_as_of then';
begin
  v_def := pg_get_functiondef('public.place_limit_order(uuid, uuid, text, text, uuid, text, numeric, numeric, timestamptz, timestamptz, timestamptz, text)'::regprocedure);
  if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
    raise exception '0060: place_limit_order expiry check not found exactly once';
  end if;
  execute replace(v_def, v_old,
    '-- 0060: and no later than delivery start, when the order leaves the market.'
    || E'\n  if v_expiry <= v_as_of or v_expiry > p_delivery_start then');
end
$$;

do $$
declare
  v_open int;
begin
  select count(*) into v_open from public.paper_orders
  where status = 'OPEN' and expires_at > delivery_start;
  raise notice '0060: % open order(s) expire after their delivery starts', v_open;
end
$$;
