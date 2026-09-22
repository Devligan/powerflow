-- =====================================================================
-- PowerFlow — transactional trade engine (Phase 3)
--
-- execute_trade runs the entire trade lifecycle atomically:
--   authenticate → validate market → validate delivery → fetch the
--   authoritative persisted price → validate quantity → validate capital /
--   exposure → insert trade → update position → update cash → audit.
-- Any failure rolls the whole transaction back.
--
-- SERVER-AUTHORITATIVE: the execution price is always the latest valid
-- persisted market price; callers cannot override it.
-- CONCURRENCY: locking the paper_accounts row serializes per-user trades,
-- so no two requests can observe the same balance and overspend.
-- =====================================================================

create or replace function public.execute_trade(
  p_user_id uuid,
  p_market_id uuid,
  p_side text,
  p_quantity_mwh numeric,
  p_delivery_start timestamptz,
  p_delivery_end timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_market    public.markets%rowtype;
  v_price     public.market_prices%rowtype;
  v_account   public.paper_accounts%rowtype;
  v_pos       public.positions%rowtype;
  v_prev_qty  numeric;
  v_prev_avg  numeric;
  v_new_qty   numeric;
  v_new_avg   numeric;
  v_closed    numeric;
  v_realized_delta numeric := 0;
  v_notional  numeric;
  v_gross_others numeric;
  v_gross_new numeric;
  v_trade_id  uuid;
  v_exec_at   timestamptz := now();
begin
  -- 0. Authorization: callers may only trade their own account.
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'FORBIDDEN';
  end if;

  -- 1. Market must exist and be active.
  select * into v_market
  from public.markets
  where id = p_market_id and active
  for share;
  if not found then
    raise exception 'MARKET_INVALID';
  end if;

  -- 2. Validate inputs.
  if p_side is null or p_side not in ('BUY', 'SELL') then
    raise exception 'SIDE_INVALID';
  end if;
  if p_quantity_mwh is null or p_quantity_mwh <= 0 then
    raise exception 'QUANTITY_INVALID';
  end if;
  if p_delivery_start is null or p_delivery_end is null then
    raise exception 'DELIVERY_INVALID';
  end if;
  if p_delivery_start >= p_delivery_end then
    raise exception 'DELIVERY_INVALID';
  end if;
  if extract(epoch from (p_delivery_end - p_delivery_start)) <> 3600 then
    raise exception 'DELIVERY_MUST_BE_1_HOUR';
  end if;
  if extract(minute from p_delivery_start) <> 0
     or extract(second from p_delivery_start) <> 0 then
    raise exception 'DELIVERY_MUST_BE_HOURLY';
  end if;
  -- Don't allow trading already-settled past hours.
  if p_delivery_end <= v_exec_at then
    raise exception 'DELIVERY_IN_THE_PAST';
  end if;
  if p_delivery_start > v_exec_at + interval '35 days' then
    raise exception 'DELIVERY_TOO_FAR_OUT';
  end if;

  -- 3. Authoritative execution price: latest valid persisted price.
  --    (Remains available if ERCOT is down; staleness is surfaced in the UI.)
  select * into v_price
  from public.market_prices
  where market_id = p_market_id
  order by delivery_timestamp desc
  limit 1
  for share;
  if not found then
    raise exception 'PRICE_UNAVAILABLE';
  end if;

  -- 4. Serialize per-user trade execution.
  select * into v_account
  from public.paper_accounts
  where user_id = p_user_id
  for update;
  if not found then
    raise exception 'ACCOUNT_NOT_FOUND';
  end if;

  v_notional := v_price.price * p_quantity_mwh;

  -- 5a. Capital check: BUY must be fully covered by virtual cash.
  if p_side = 'BUY' and v_notional > v_account.cash_balance then
    raise exception 'INSUFFICIENT_CAPITAL';
  end if;

  -- 5b. Exposure check against the configured gross margin limit.
  select * into v_pos
  from public.positions
  where user_id = p_user_id
    and market_id = p_market_id
    and delivery_start = p_delivery_start
    and delivery_end = p_delivery_end
  for update;

  with latest as (
    select distinct on (mp.market_id) mp.market_id, mp.price
    from public.market_prices mp
    order by mp.market_id, mp.delivery_timestamp desc
  )
  select coalesce(sum(abs(pos.quantity_mwh) * l.price), 0)
    into v_gross_others
  from public.positions pos
  join latest l on l.market_id = pos.market_id
  where pos.user_id = p_user_id
    and pos.quantity_mwh <> 0
    and not (
      pos.market_id = p_market_id
      and pos.delivery_start = p_delivery_start
      and pos.delivery_end = p_delivery_end
    );

  v_new_qty := coalesce(v_pos.quantity_mwh, 0)
    + case when p_side = 'BUY' then p_quantity_mwh else - p_quantity_mwh end;

  v_gross_new := v_gross_others + abs(v_new_qty) * v_price.price;
  if v_gross_new > v_account.max_gross_notional then
    raise exception 'EXPOSURE_LIMIT_EXCEEDED';
  end if;

  -- 6. Position accounting (weighted-average cost, signed quantity).
  v_prev_qty := coalesce(v_pos.quantity_mwh, 0);
  v_prev_avg := coalesce(v_pos.average_entry_price, 0);
  v_new_avg  := v_prev_avg;

  if v_prev_qty = 0 then
    -- Opening trade.
    v_new_avg := v_price.price;
  elsif v_prev_qty > 0 then
    if p_side = 'BUY' then
      -- Growing the long → weighted average.
      v_new_avg := (v_prev_qty * v_prev_avg + p_quantity_mwh * v_price.price)
                   / (v_prev_qty + p_quantity_mwh);
    else
      -- SELL against a long → close/reduce/flip.
      v_closed := least(p_quantity_mwh, v_prev_qty);
      v_realized_delta := v_realized_delta + (v_price.price - v_prev_avg) * v_closed;
      if v_new_qty < 0 then
        v_new_avg := v_price.price;
      end if;
    end if;
  else
    -- v_prev_qty < 0 → short position.
    if p_side = 'SELL' then
      -- Adding to the short → weighted average on absolute exposure.
      v_new_avg := (abs(v_prev_qty) * v_prev_avg + p_quantity_mwh * v_price.price)
                   / (abs(v_prev_qty) + p_quantity_mwh);
    else
      -- BUY against a short → close/reduce/flip.
      v_closed := least(p_quantity_mwh, abs(v_prev_qty));
      v_realized_delta := v_realized_delta + (v_prev_avg - v_price.price) * v_closed;
      if v_new_qty > 0 then
        v_new_avg := v_price.price;
      end if;
    end if;
  end if;

  -- 7. Update cash transactionally with the trade.
  if p_side = 'BUY' then
    update public.paper_accounts
       set cash_balance = cash_balance - v_notional, updated_at = v_exec_at
     where id = v_account.id;
  else
    update public.paper_accounts
       set cash_balance = cash_balance + v_notional, updated_at = v_exec_at
     where id = v_account.id;
  end if;

  -- 8. Insert the immutable trade record.
  insert into public.trades (
    user_id, market_id, side, quantity_mwh,
    delivery_start, delivery_end,
    execution_price, price_timestamp, market_price_id,
    status, created_at, executed_at
  ) values (
    p_user_id, p_market_id, p_side, p_quantity_mwh,
    p_delivery_start, p_delivery_end,
    v_price.price, v_price.delivery_timestamp, v_price.id,
    'EXECUTED', v_exec_at, v_exec_at
  )
  returning id into v_trade_id;

  -- 9. Upsert the position.
  insert into public.positions (
    user_id, market_id, delivery_start, delivery_end,
    quantity_mwh, average_entry_price, realized_pnl, updated_at
  ) values (
    p_user_id, p_market_id, p_delivery_start, p_delivery_end,
    v_new_qty, v_new_avg,
    coalesce(v_pos.realized_pnl, 0) + v_realized_delta,
    v_exec_at
  )
  on conflict (user_id, market_id, delivery_start, delivery_end)
  do update set
    quantity_mwh       = excluded.quantity_mwh,
    average_entry_price = excluded.average_entry_price,
    realized_pnl       = excluded.realized_pnl,
    updated_at         = excluded.updated_at;

  -- 10. Audit the event (immutable).
  insert into public.audit_events (
    user_id, event_type, entity_type, entity_id, metadata
  ) values (
    p_user_id, 'TRADE_EXECUTED', 'trade', v_trade_id,
    jsonb_build_object(
      'side', p_side,
      'quantity_mwh', p_quantity_mwh,
      'execution_price', v_price.price,
      'price_timestamp', v_price.delivery_timestamp,
      'market_price_id', v_price.id,
      'market_id', p_market_id,
      'delivery_start', to_char(p_delivery_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'delivery_end', to_char(p_delivery_end at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'notional', v_notional,
      'realized_delta', v_realized_delta,
      'position_quantity', v_new_qty
    )
  );

  return jsonb_build_object(
    'trade_id', v_trade_id,
    'side', p_side,
    'quantity_mwh', p_quantity_mwh,
    'execution_price', v_price.price,
    'price_timestamp', v_price.delivery_timestamp,
    'market_price_id', v_price.id,
    'notional', v_notional,
    'realized_delta', v_realized_delta,
    'cash_balance', (select cash_balance from public.paper_accounts where id = v_account.id),
    'position_quantity', v_new_qty,
    'position_average_entry_price', v_new_avg,
    'executed_at', v_exec_at
  );
end;
$$;

grant execute on function public.execute_trade(uuid, uuid, text, numeric, timestamptz, timestamptz)
  to authenticated;