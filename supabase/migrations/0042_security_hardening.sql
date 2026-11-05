-- =====================================================================
-- 0042 — Close the paths around the engine
--
-- A security review reproduced each of these against the deployed schema.
-- A session's JWT works against PostgREST directly, so a rule that lives only
-- in a route handler is a suggestion: everything below is enforced here.
--
--   1. paper_orders accepted direct INSERT and UPDATE from its owner (0026
--      policies). An order written that way skipped place_limit_order's
--      deadline, credit and size checks, and the sweep filled it: a 2 billion
--      MW position on an account holding $100,000, placed after the market
--      had cleared. Orders are now written by the engine only.
--   2. Tables kept Supabase's default grants, TRUNCATE included (RLS does not
--      govern TRUNCATE). Roles now hold only what they use.
--   3. The simulation clock let an account bid on hours whose result it could
--      read, then bank the result; or park before delivery so a loss never
--      settled; and both count on the public standings. Replay stays, but
--      results that depend on it no longer rank (replay_tainted_at), the clock
--      cannot run ahead of the wall, and every move is audited.
--   4. place_limit_order had no lock, so concurrent bids each passed the same
--      credit check. It also took any instrument (a short ENERGY_SPOT credits
--      cash, inflating its own collateral), any size that fit, windows
--      execute_trade would refuse at fill time, and any number of dust orders.
--   5. The sweep took orders soonest-delivery first with a global limit, so
--      one account's unfillable book could stop every other account filling.
--      It now serves accounts in turn, and a clock move sweeps one account.
--   6. handle_new_user trusted signup metadata for avatar_url, which is
--      caller-supplied on an email signup.
--   7. Maintenance margin came out negative on a negative mark (a PTP path).
--
-- Also new: rate_limit_hit, the counter behind the API's rate limits.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Orders are written by the engine only
-- ---------------------------------------------------------------------
drop policy if exists paper_orders_insert_own on public.paper_orders;
drop policy if exists paper_orders_update_own on public.paper_orders;
drop policy if exists paper_orders_select_own on public.paper_orders;
create policy paper_orders_select_own on public.paper_orders
  for select to authenticated
  using (auth.uid() = user_id);

-- NOT VALID: it binds every new row without judging history.
alter table public.paper_orders drop constraint if exists paper_orders_quantity_max;
alter table public.paper_orders
  add constraint paper_orders_quantity_max check (quantity_mwh <= 1000) not valid;

-- ---------------------------------------------------------------------
-- 2. Least privilege
-- ---------------------------------------------------------------------
revoke insert, update, delete, truncate, references, trigger, maintain
  on all tables in schema public from anon, authenticated;
revoke all on
  public.audit_events, public.ingestion_runs, public.paper_accounts,
  public.paper_orders, public.positions, public.profiles, public.trades
  from anon;
revoke select on public.ingestion_runs from authenticated;

alter default privileges for role postgres in schema public
  revoke insert, update, delete, truncate, references, trigger, maintain
  on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon;

-- A view runs with its owner's rights unless told otherwise.
alter view public.current_prices set (security_invoker = true);

-- Price reads are public through market_prices; nothing unauthenticated needs
-- to call the engine's internals.
revoke execute on function public.instrument_entry_price(uuid,uuid,text,text,timestamptz,timestamptz,timestamptz) from public, anon;
revoke execute on function public.instrument_settlement_price(uuid,uuid,text,text,timestamptz,timestamptz) from public, anon;
revoke execute on function public.latest_final_price_timestamps(uuid[]) from public, anon;
revoke execute on function public.price_as_of(uuid,text,timestamptz,timestamptz) from public, anon;
revoke execute on function public.price_at(uuid,text,timestamptz,timestamptz) from public, anon;
revoke execute on function public.price_average(uuid,text,timestamptz,timestamptz,timestamptz) from public, anon;
revoke execute on function public.price_final(uuid,text,timestamptz) from public, anon;
revoke execute on function public.price_is_stale(uuid,text,timestamptz,timestamptz) from public, anon;
revoke execute on function public.price_latest_in_window(uuid,text,timestamptz,timestamptz,timestamptz) from public, anon;
revoke execute on function public.price_row_id(uuid,text,timestamptz,timestamptz) from public, anon;
revoke execute on function public.sim_now(uuid) from public, anon;
-- Called only from inside definer functions.
revoke execute on function public.mint_username(text,uuid) from public, anon, authenticated;

alter function public.latest_final_price_timestamps(uuid[]) set search_path = public;
alter function public.latest_price_timestamps(uuid[]) set search_path = public;
alter function public.prevent_audit_mutation() set search_path = public;
alter function public.prevent_trade_mutation() set search_path = public;
alter function public.set_updated_at() set search_path = public;

-- ---------------------------------------------------------------------
-- 3. The clock, and what replay results are worth
-- ---------------------------------------------------------------------
alter table public.paper_accounts
  add column if not exists replay_tainted_at timestamptz;

comment on column public.paper_accounts.replay_tainted_at is
  'Set when the account traded, or held a book, on a displaced clock. Its results no longer rank on the public standings. Migration 0042.';

alter table public.audit_events drop constraint if exists audit_event_type_valid;
alter table public.audit_events
  add constraint audit_event_type_valid
  check (
    event_type in (
      'USER_CREATED',
      'ACCOUNT_CREATED',
      'TRADE_CREATED',
      'TRADE_VALIDATED',
      'TRADE_EXECUTED',
      'TRADE_REJECTED',
      'POSITION_UPDATED',
      'PROFILE_UPDATED',
      'LEADERBOARD_OPT_IN_CHANGED',
      'POSITION_SETTLED',
      'ORDER_PLACED',
      'ORDER_FILLED',
      'ORDER_CANCELLED',
      'MARGIN_CALL',
      'FORCED_LIQUIDATION',
      'ACCOUNT_DEFICIT',
      'DEFICIT_REPAID',
      'SIM_CLOCK_CHANGED'
    )
  );

-- Accounts already holding a result that depended on the clock. sim_as_of is
-- recorded on every fill since 0021; older fills have none and are left alone.
update public.paper_accounts a
set replay_tainted_at = now()
where a.replay_tainted_at is null
  and (
    exists (
      select 1 from public.trades t
      where t.user_id = a.user_id
        and t.status = 'EXECUTED'
        and t.execution_result ? 'sim_as_of'
        and abs(extract(epoch from
              ((t.execution_result ->> 'sim_as_of')::timestamptz - t.executed_at))) > 300
    )
    or (a.sim_clock_offset <> 0 and (
      exists (select 1 from public.positions p
              where p.user_id = a.user_id and p.quantity_mwh <> 0)
      or exists (select 1 from public.paper_orders o
                 where o.user_id = a.user_id and o.status = 'OPEN')
    ))
  );

create or replace function public.set_sim_clock(p_user_id uuid, p_iso timestamptz)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_offset  bigint;
  v_tainted boolean;
begin
  -- Own account only (the service role passes because auth.uid() is null).
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'FORBIDDEN';
  end if;
  -- Replay means the past. The future holds no market data to trade, and the
  -- bound also keeps the nanosecond offset inside a bigint.
  if p_iso is null
     or p_iso > clock_timestamp() + interval '1 minute'
     or p_iso < timestamptz '2000-01-01 00:00:00+00' then
    raise exception 'SIM_CLOCK_INVALID';
  end if;

  -- The offset is nanoseconds; a timestamptz difference is an interval, so
  -- it goes through epoch seconds rather than an implicit (absent) cast.
  v_offset := least(0, (extract(epoch from (p_iso - clock_timestamp())) * 1000000000)::bigint);

  -- Moving the clock under an open book changes what it is marked at and when
  -- it settles, so that book's result is no longer a live result.
  v_tainted := v_offset <> 0 and (
    exists (select 1 from public.positions p
            where p.user_id = p_user_id and p.quantity_mwh <> 0)
    or exists (select 1 from public.paper_orders o
               where o.user_id = p_user_id and o.status = 'OPEN')
  );

  update public.paper_accounts
     set sim_clock_offset = v_offset,
         replay_tainted_at = case when v_tainted
                                  then coalesce(replay_tainted_at, clock_timestamp())
                                  else replay_tainted_at end
   where user_id = p_user_id;
  if not found then
    raise exception 'ACCOUNT_NOT_FOUND';
  end if;

  insert into public.audit_events (user_id, event_type, entity_type, entity_id, metadata)
  values (
    p_user_id, 'SIM_CLOCK_CHANGED', 'paper_account', null,
    jsonb_build_object('to', p_iso, 'offset_ns', v_offset, 'open_book', v_tainted)
  );
  return p_iso;
end;
$$;

revoke execute on function public.set_sim_clock(uuid, timestamptz) from public, anon;
grant execute on function public.set_sim_clock(uuid, timestamptz) to authenticated, service_role;

create or replace function public.clear_sim_clock(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'FORBIDDEN';
  end if;
  update public.paper_accounts set sim_clock_offset = 0 where user_id = p_user_id;
  if found then
    insert into public.audit_events (user_id, event_type, entity_type, entity_id, metadata)
    values (p_user_id, 'SIM_CLOCK_CHANGED', 'paper_account', null, jsonb_build_object('to', 'LIVE'));
  end if;
end;
$$;

revoke execute on function public.clear_sim_clock(uuid) from public, anon;
grant execute on function public.clear_sim_clock(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 4. place_limit_order
-- ---------------------------------------------------------------------
-- What the desk offers, in the catalog the engine reads (TS: DESK_INSTRUMENT_CODES).
alter table public.instruments
  add column if not exists orderable boolean not null default false;
update public.instruments
set orderable = code in ('VIRTUAL', 'PTP_OBLIGATION');

create or replace function public.place_limit_order(
  p_user_id uuid,
  p_market_id uuid,
  p_instrument text,
  p_product text,
  p_counter_market_id uuid,
  p_side text,
  p_quantity_mwh numeric,
  p_limit_price numeric,
  p_delivery_start timestamptz,
  p_delivery_end timestamptz,
  p_expires_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account public.paper_accounts%rowtype;
  v_instr   public.instruments%rowtype;
  v_product public.products%rowtype;
  v_counter public.markets%rowtype;
  v_as_of   timestamptz;
  v_expiry  timestamptz;
  v_type    text;
  v_order_id uuid;
  v_window_ms numeric;
  v_interval_ms numeric;
begin
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'FORBIDDEN';
  end if;

  -- One order at a time per account: the credit and open-order checks below
  -- read the book and then add to it.
  select * into v_account
  from public.paper_accounts
  where user_id = p_user_id
  for update;
  if not found then
    raise exception 'ACCOUNT_NOT_FOUND';
  end if;

  v_as_of := public.sim_now(p_user_id);

  -- Instrument + product: the same catalog rules execute_trade enforces.
  select * into v_instr from public.instruments where code = p_instrument;
  if not found then
    raise exception 'INSTRUMENT_INVALID';
  end if;
  if not v_instr.tradable or not v_instr.orderable then
    raise exception 'INSTRUMENT_NOT_TRADABLE';
  end if;

  select * into v_product
  from public.products
  where code = case
                 when v_instr.product_from_trade then p_product
                 else 'DAM_HOURLY'
               end;
  if not found then
    raise exception 'PRODUCT_INVALID';
  end if;
  if v_instr.product_from_trade and not v_product.tradable then
    raise exception 'PRODUCT_NOT_TRADABLE';
  end if;

  -- The source point must be open too, not only the sink.
  if not exists (select 1 from public.markets where id = p_market_id and active) then
    raise exception 'MARKET_INVALID';
  end if;

  -- Path legs.
  if v_instr.settlement_rule in ('DIFFERENCE', 'CONGESTION_CONVERGENCE') then
    if p_counter_market_id is null then
      raise exception 'COUNTER_POINT_REQUIRED';
    end if;
    if p_counter_market_id = p_market_id then
      raise exception 'COUNTER_POINT_INVALID';
    end if;
    select * into v_counter
    from public.markets
    where id = p_counter_market_id and active;
    if not found then
      raise exception 'COUNTER_POINT_INVALID';
    end if;
  elsif p_counter_market_id is not null then
    raise exception 'COUNTER_POINT_INVALID';
  end if;

  -- Sides, size, price. No limit = a MARKET order: fill at the clearing price.
  if p_side is null or p_side not in ('BUY', 'SELL') then
    raise exception 'SIDE_INVALID';
  end if;
  if p_quantity_mwh is null or p_quantity_mwh <= 0 or p_quantity_mwh > 1000
     or p_quantity_mwh <> round(p_quantity_mwh, 6) then
    raise exception 'QUANTITY_INVALID';
  end if;
  if p_limit_price is not null and (p_limit_price < -250 or p_limit_price > 5000) then
    raise exception 'LIMIT_PRICE_INVALID';
  end if;
  v_type := case when p_limit_price is null then 'MARKET' else 'LIMIT' end;

  -- Delivery: the instant engine's rules, so what is accepted here can fill.
  -- The order commits to an interval; if no price ever prints for it, the
  -- order expires unfilled rather than filling at an invented price.
  if p_delivery_start is null or p_delivery_end is null
     or p_delivery_end <= p_delivery_start then
    raise exception 'DELIVERY_INVALID';
  end if;

  v_interval_ms := v_product.interval_minutes * 60 * 1000;
  v_window_ms := extract(epoch from (p_delivery_end - p_delivery_start)) * 1000;
  if v_instr.settlement_rule = 'AVERAGE' then
    if mod(v_window_ms, v_interval_ms) <> 0 then
      raise exception 'DELIVERY_WINDOW_INVALID';
    end if;
  elsif v_window_ms <> v_interval_ms then
    raise exception 'DELIVERY_INTERVAL_INVALID';
  end if;
  if mod(extract(epoch from p_delivery_start) * 1000, v_interval_ms) <> 0
     or mod(extract(epoch from p_delivery_end) * 1000, v_interval_ms) <> 0 then
    raise exception 'DELIVERY_MUST_BE_ALIGNED';
  end if;

  if p_delivery_start <= v_as_of then
    raise exception 'DELIVERY_IN_PAST';
  end if;
  if p_delivery_start > v_as_of + interval '35 days' then
    raise exception 'DELIVERY_TOO_FAR_OUT';
  end if;
  -- 0038: day-ahead bids close at 10:00 Central the day before.
  if v_product.code like 'DAM%' and v_as_of >= public.dam_gate(p_delivery_start) then
    raise exception 'DAM_CLOSED';
  end if;

  -- A bounded book: every open order is sweep work, and a dust order holds
  -- next to no collateral, so collateral alone does not bound them.
  if (select count(*) from public.paper_orders
      where user_id = p_user_id and status = 'OPEN') >= 500 then
    raise exception 'OPEN_ORDER_LIMIT';
  end if;

  -- 0040: collateral. Every open bid, and this one, holds MW x the point's
  -- exposure factor; together they must fit within the account's cash.
  if (select coalesce(sum(x.q * public.bid_exposure_factor(x.m)), 0)
      from (select market_id m, sum(quantity_mwh) q
            from public.paper_orders
            where user_id = p_user_id and status = 'OPEN'
            group by market_id) x)
     + p_quantity_mwh * public.bid_exposure_factor(p_market_id)
     -- 0041: every open margined position holds its collateral too.
     + (select coalesce(sum(abs(pos.quantity_mwh) * public.bid_exposure_factor(pos.market_id)), 0)
        from public.positions pos
        where pos.user_id = p_user_id and pos.quantity_mwh <> 0
          and public.is_margined_instrument(pos.instrument))
     > v_account.cash_balance then
    raise exception 'CREDIT_LIMIT_EXCEEDED';
  end if;

  -- Expiry: bounded so a forgotten order cannot live forever. Default is
  -- 7 days out; an explicit value must be in the future.
  v_expiry := coalesce(p_expires_at, v_as_of + interval '7 days');
  if v_expiry <= v_as_of then
    raise exception 'EXPIRY_INVALID';
  end if;

  -- A bid placed on a displaced clock is replay practice, not a live result.
  if v_account.sim_clock_offset <> 0 and v_account.replay_tainted_at is null then
    update public.paper_accounts
       set replay_tainted_at = clock_timestamp()
     where id = v_account.id;
  end if;

  insert into public.paper_orders (
    user_id, market_id, product, instrument, counter_market_id,
    side, quantity_mwh, order_type, limit_price,
    delivery_start, delivery_end, expires_at
  ) values (
    p_user_id, p_market_id, v_product.code, v_instr.code, p_counter_market_id,
    p_side, p_quantity_mwh, v_type, p_limit_price,
    p_delivery_start, p_delivery_end, v_expiry
  )
  returning id into v_order_id;

  insert into public.audit_events (
    user_id, event_type, entity_type, entity_id, metadata
  ) values (
    p_user_id, 'ORDER_PLACED', 'paper_order', v_order_id,
    jsonb_build_object(
      'side', p_side,
      'instrument', v_instr.code,
      'product', v_product.code,
      'order_type', v_type,
      'limit_price', p_limit_price,
      'quantity_mwh', p_quantity_mwh,
      'delivery_start', to_char(p_delivery_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'delivery_end', to_char(p_delivery_end at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'expires_at', v_expiry
    )
  );

  return v_order_id;
end;
$$;

revoke execute on function public.place_limit_order(uuid,uuid,text,text,uuid,text,numeric,numeric,timestamptz,timestamptz,timestamptz) from public, anon;
grant execute on function public.place_limit_order(uuid,uuid,text,text,uuid,text,numeric,numeric,timestamptz,timestamptz,timestamptz) to authenticated;

-- ---------------------------------------------------------------------
-- 5. The fill sweep
-- ---------------------------------------------------------------------
drop function if exists public.fill_crossing_limit_orders(integer);

create or replace function public.fill_crossing_limit_orders(
  p_limit integer default 500,
  p_user_id uuid default null
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_wall       timestamptz := clock_timestamp();
  v_clock      timestamptz;
  v_considered int := 0;
  v_filled     int := 0;
  v_expired    int := 0;
  v_errors     int := 0;
  v_error_samples jsonb := '[]'::jsonb;
  v_order      public.paper_orders%rowtype;
  v_market     public.markets%rowtype;
  v_price      numeric;
  v_result     jsonb;
begin
  if current_user <> 'service_role' then
    raise exception 'FORBIDDEN: fill_crossing_limit_orders is a service_role job';
  end if;
  if p_limit is null or p_limit <= 0 then
    raise exception 'LIMIT_INVALID';
  end if;

  -- Expire first, each on its own account's clock: past its expiry, or its
  -- delivery has started (0037) — an order never fills into a live period.
  update public.paper_orders o
  set status = 'EXPIRED', updated_at = v_wall
  where o.status = 'OPEN'
    and (p_user_id is null or o.user_id = p_user_id)
    and (o.expires_at <= public.sim_now(o.user_id)
         or o.delivery_start <= public.sim_now(o.user_id));
  get diagnostics v_expired = row_count;

  -- Accounts are served in turn: every account's soonest order, then every
  -- account's next, so a large book cannot take the whole limit.
  for v_order in
    select o.*
    from public.paper_orders o
    join (
      select id,
             row_number() over (partition by user_id
                                order by delivery_start, created_at) as turn
      from public.paper_orders
      where status = 'OPEN'
        and (p_user_id is null or user_id = p_user_id)
    ) q on q.id = o.id
    order by q.turn, o.delivery_start, o.created_at
    limit p_limit
  loop
    v_considered := v_considered + 1;

    begin
      v_clock := public.sim_now(v_order.user_id);
      if v_clock is null or v_order.delivery_start <= v_clock then
        continue;
      end if;

      select * into v_market
      from public.markets
      where id = v_order.market_id and active;
      if not found then
        raise exception 'MARKET_INVALID';
      end if;

      -- The price the fill would be made at, as visible on the account's
      -- clock: the same rule execute_trade applies. Not cleared yet → wait.
      v_price := public.instrument_entry_price(
        v_order.market_id, v_order.counter_market_id, v_order.instrument,
        v_order.product, v_order.delivery_start, v_order.delivery_end, v_clock
      );
      if v_price is null then
        continue;
      end if;

      -- MARKET fills at whatever cleared. LIMIT: BUY at or below, SELL at or
      -- above; ties fill. The fill price is the clearing price itself.
      if v_order.order_type = 'MARKET'
         or (v_order.side = 'BUY' and v_price <= v_order.limit_price)
         or (v_order.side = 'SELL' and v_price >= v_order.limit_price) then

        v_result := public.execute_trade(
          v_order.user_id,
          v_order.market_id,
          v_order.counter_market_id,
          v_order.instrument,
          v_order.product,
          v_order.side,
          v_order.quantity_mwh,
          v_order.delivery_start,
          v_order.delivery_end,
          -- Per-order idempotency key: a sweep retry replays the fill
          -- instead of re-executing (execute_trade step 0c).
          'sweep-' || v_order.id::text
        );

        update public.paper_orders
        set status = 'FILLED',
            filled_trade_id = (v_result->>'trade_id')::uuid,
            updated_at = v_wall
        where id = v_order.id and status = 'OPEN';

        if found then
          v_filled := v_filled + 1;

          insert into public.audit_events (
            user_id, event_type, entity_type, entity_id, metadata
          ) values (
            v_order.user_id, 'ORDER_FILLED', 'paper_order', v_order.id,
            jsonb_build_object(
              'trade_id', v_result->>'trade_id',
              'fill_price', v_result->>'execution_price',
              'order_type', v_order.order_type,
              'limit_price', v_order.limit_price,
              'side', v_order.side,
              'quantity_mwh', v_order.quantity_mwh
            )
          );
        end if;
      end if;
    exception when others then
      -- One bad order must not stall the book; samples go to the summary.
      v_errors := v_errors + 1;
      if v_errors <= 5 then
        v_error_samples := v_error_samples
          || jsonb_build_object('order_id', v_order.id, 'error', sqlerrm);
      end if;
    end;
  end loop;

  return jsonb_build_object(
    'considered', v_considered,
    'filled', v_filled,
    'expired', v_expired,
    'errors', v_errors,
    'error_samples', v_error_samples
  );
end;
$$;

revoke execute on function public.fill_crossing_limit_orders(integer, uuid) from public, anon, authenticated;
grant execute on function public.fill_crossing_limit_orders(integer, uuid) to service_role;

-- ---------------------------------------------------------------------
-- 6. Signup metadata
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_avatar text;
begin
  -- user_metadata is the caller's to write on an email signup; only an
  -- identity provider's picture has come from somewhere else.
  if coalesce(new.raw_app_meta_data ->> 'provider', 'email') <> 'email' then
    v_avatar := coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture');
    if v_avatar !~ '^https://' or char_length(v_avatar) > 1024 then
      v_avatar := null;
    end if;
  end if;

  insert into public.profiles (id, username, display_name, avatar_url)
  values (
    new.id,
    public.mint_username(new.email, new.id),
    -- A name the person gave their identity provider, never the email.
    nullif(btrim(left(regexp_replace(coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      ''
    ), '[[:cntrl:]]', ' ', 'g'), 40)), ''),
    v_avatar
  )
  on conflict (id) do nothing;

  insert into public.paper_accounts (user_id, starting_cash, cash_balance)
  values (new.id, 100000, 100000)
  on conflict (user_id) do nothing;

  insert into public.audit_events (user_id, event_type, entity_type, entity_id, metadata)
  values (new.id, 'USER_CREATED', 'user', new.id, jsonb_build_object('email', new.email))
  on conflict do nothing;

  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- Email accounts can hold only a picture this app stored (random name, our
-- bucket). Anything else arrived through the metadata path above.
update public.profiles p
set avatar_url = null
from auth.users u
where u.id = p.id
  and p.avatar_url is not null
  and coalesce(u.raw_app_meta_data ->> 'provider', 'email') = 'email'
  and p.avatar_url !~ '^https://[a-z0-9]+\.supabase\.co/storage/v1/object/public/avatars/[0-9a-f-]{36}\.(png|jpg|webp)$';

-- ---------------------------------------------------------------------
-- 7 + standings: patched in place, as 0028/0037/0041 did, each patch checked
-- ---------------------------------------------------------------------
do $$
declare
  r record;
  v_def text;
begin
  for r in
    select * from (values
      ('public.get_leaderboard(integer)'::regprocedure,
       E'  where pr.leaderboard_opt_in\n',
       E'  where pr.leaderboard_opt_in\n'
       || E'    -- 0042: a result that depended on the replay clock does not rank.\n'
       || E'    and ac.replay_tainted_at is null\n'),
      ('public.account_margin(uuid)'::regprocedure,
       E'sum(abs(p.quantity_mwh) * m.mark * a.initial_margin_rate)',
       E'sum(abs(p.quantity_mwh) * abs(m.mark) * a.initial_margin_rate)'),
      ('public.account_margin(uuid)'::regprocedure,
       E'sum(abs(p.quantity_mwh) * m.mark * a.maintenance_margin_rate)',
       E'sum(abs(p.quantity_mwh) * abs(m.mark) * a.maintenance_margin_rate)')
    ) as t(fn, old_text, new_text)
  loop
    v_def := pg_get_functiondef(r.fn);
    if position(r.new_text in v_def) > 0 then
      continue; -- already applied
    end if;
    if position(r.old_text in v_def) = 0 then
      raise exception '0042: expected text not found in %: %', r.fn, left(r.old_text, 80);
    end if;
    execute replace(v_def, r.old_text, r.new_text);
  end loop;
end
$$;

-- ---------------------------------------------------------------------
-- Rate limits: a fixed-window counter the API reaches with the service role
-- ---------------------------------------------------------------------
create table if not exists public.rate_limits (
  key text primary key,
  window_start timestamptz not null,
  hits integer not null
);

alter table public.rate_limits enable row level security;
revoke all on public.rate_limits from public, anon, authenticated;

-- True while the caller is inside the limit. `key` carries hashes, never an
-- address: this table must not become a list of who tried what.
create or replace function public.rate_limit_hit(
  p_key text,
  p_max integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now  timestamptz := clock_timestamp();
  v_from timestamptz := v_now - make_interval(secs => p_window_seconds);
  v_hits integer;
begin
  insert into public.rate_limits as r (key, window_start, hits)
  values (p_key, v_now, 1)
  on conflict (key) do update
    set window_start = case when r.window_start <= v_from then v_now else r.window_start end,
        hits = case when r.window_start <= v_from then 1 else r.hits + 1 end
  returning hits into v_hits;

  -- Opportunistic cleanup: the table stays small without a scheduled job.
  if random() < 0.01 then
    delete from public.rate_limits where window_start < v_now - interval '2 days';
  end if;

  return v_hits <= p_max;
end;
$$;

revoke execute on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;
