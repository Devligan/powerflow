-- =====================================================================
-- 0044 — Settle on ERCOT's calendar, at ERCOT's corrected prices
--
-- ERCOT's prices are not final when they are first printed. Real-time
-- Settlement Point Prices are final at 16:00 Central on the second Business
-- Day after the Operating Day, day-ahead prices at 10:00 that same day
-- (Protocols 6.3 and 4.5.3; the "Price Validation and Corrections" business
-- practice). Until then ERCOT can correct them, and does: its NP4-197 report
-- posts the corrected 15-minute prices, e.g. Operating Day 2026-08-30 was
-- corrected at 15:20 on 2026-09-01 with a PriceCorrectionTime of 16:00, hub
-- and load-zone prints among them.
--
-- The desk settled at 24:00 on the delivery day, on the first print (0024),
-- two business days before ERCOT would, and never saw a correction.
--
--   1. The Business Day calendar (Section 2.1): Monday to Friday less
--      ERCOT's observed holidays. A rule, not a table, so it never runs out;
--      the two Christmas days are the CEO's to designate and follow the years
--      ERCOT has published. Mirror: src/lib/ercot/settlement-calendar.ts.
--   2. ercot_price_final_at(product, interval) and position_final_at(...):
--      when a price, and so a position, is final.
--   3. promote_rtm_finals promotes an hourly real-time price at its finality
--      instant instead of at the end of its day.
--   4. settle_delivered_positions, on an account's own clock, waits for the
--      same instant, so a replay account settles when ERCOT would have too.
--      An explicit p_as_of (tests, a backfill) still settles on whatever is
--      marked final, as before.
--   5. apply_rtm_price_corrections: the ingestion job hands it one NP4-197
--      document; it publishes the corrected 15-minute prints the store
--      already holds as new observations and re-publishes each affected
--      hour, re-averaged. Each document is applied once.
--
-- A correction posted after a position settled (a Board-directed one, months
-- later) updates prices and marks but does not resettle the position; ERCOT
-- would issue a resettlement statement.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Business Days
-- ---------------------------------------------------------------------
create or replace function public.ercot_is_holiday(p_day date)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
declare
  y int := extract(year from p_day)::int;
  v_d date;
  v_xmas_dow int;
begin
  -- New Year's Day and Independence Day: a Saturday is observed on the
  -- Friday before (New Year's in the previous year), a Sunday on the Monday.
  foreach v_d in array array[make_date(y, 1, 1), make_date(y + 1, 1, 1), make_date(y, 7, 4)] loop
    v_d := case extract(dow from v_d)::int when 6 then v_d - 1 when 0 then v_d + 1 else v_d end;
    if v_d = p_day then
      return true;
    end if;
  end loop;

  -- Martin Luther King, Jr. Day, since 2020 (NPRR943): third Monday of January.
  v_d := make_date(y, 1, 1);
  if y >= 2020 and p_day = v_d + ((1 - extract(dow from v_d)::int + 7) % 7) + 14 then
    return true;
  end if;
  -- Memorial Day: last Monday of May.
  v_d := make_date(y, 5, 31);
  if p_day = v_d - ((extract(dow from v_d)::int - 1 + 7) % 7) then
    return true;
  end if;
  -- Labor Day: first Monday of September.
  v_d := make_date(y, 9, 1);
  if p_day = v_d + ((1 - extract(dow from v_d)::int + 7) % 7) then
    return true;
  end if;
  -- Thanksgiving Thursday and Friday.
  v_d := make_date(y, 11, 1);
  v_d := v_d + ((4 - extract(dow from v_d)::int + 7) % 7) + 21;
  if p_day in (v_d, v_d + 1) then
    return true;
  end if;

  -- Two days at Christmas, kept next to the weekend.
  v_xmas_dow := extract(dow from make_date(y, 12, 25))::int;
  return p_day = any (case v_xmas_dow
    when 1 then array[make_date(y, 12, 25), make_date(y, 12, 26)]
    when 4 then array[make_date(y, 12, 25), make_date(y, 12, 26)]
    when 6 then array[make_date(y, 12, 24), make_date(y, 12, 27)]
    when 0 then array[make_date(y, 12, 23), make_date(y, 12, 26)]
    else        array[make_date(y, 12, 24), make_date(y, 12, 25)]
  end);
end;
$$;

create or replace function public.ercot_business_day_after(p_day date, p_n int)
returns date
language plpgsql
immutable
set search_path = public
as $$
declare
  v_day date := p_day;
  v_left int := p_n;
begin
  if p_n is null or p_n < 1 then
    raise exception 'BUSINESS_DAYS_INVALID';
  end if;
  while v_left > 0 loop
    v_day := v_day + 1;
    if extract(isodow from v_day) < 6 and not public.ercot_is_holiday(v_day) then
      v_left := v_left - 1;
    end if;
  end loop;
  return v_day;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. Finality
-- ---------------------------------------------------------------------
-- The interval's Operating Day is the Central date it starts on (as in
-- dam_gate, so HE24 belongs to the day it starts in).
create or replace function public.ercot_price_final_at(p_product text, p_ts timestamptz)
returns timestamptz
language sql
stable
set search_path = public
as $$
  select ((public.ercot_business_day_after((p_ts at time zone 'America/Chicago')::date, 2)::timestamp
           + case when p_product like 'RTM%' then time '16:00' else time '10:00' end)
          at time zone 'America/Chicago')
$$;

-- A position is final when the last interval it settles on is. Convergence
-- instruments settle on real time whatever product they were bid in.
create or replace function public.position_final_at(
  p_instrument text,
  p_product text,
  p_delivery_end timestamptz
)
returns timestamptz
language sql
stable
set search_path = public
as $$
  select public.ercot_price_final_at(
    case when (select i.settlement_rule from public.instruments i where i.code = p_instrument)
              in ('CONVERGENCE', 'CONGESTION_CONVERGENCE')
         then 'RTM_HOURLY' else p_product end,
    p_delivery_end - interval '1 microsecond')
$$;

revoke execute on function public.ercot_is_holiday(date) from public, anon;
revoke execute on function public.ercot_business_day_after(date, int) from public, anon;
revoke execute on function public.ercot_price_final_at(text, timestamptz) from public, anon;
revoke execute on function public.position_final_at(text, text, timestamptz) from public, anon;
grant execute on function public.ercot_is_holiday(date) to authenticated, service_role;
grant execute on function public.ercot_business_day_after(date, int) to authenticated, service_role;
grant execute on function public.ercot_price_final_at(text, timestamptz) to authenticated, service_role;
grant execute on function public.position_final_at(text, text, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 3. Promotion at ERCOT's finality
-- ---------------------------------------------------------------------
create or replace function public.promote_rtm_finals()
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_promoted integer := 0;
begin
  if current_user <> 'service_role' then
    raise exception 'FORBIDDEN: promote_rtm_finals is a service_role job';
  end if;

  -- Every still-interim hourly real-time observation whose price ERCOT has
  -- declared final (0044: 16:00 Central, second Business Day after its
  -- Operating Day). Grouped per (market, interval): every vintage of a due
  -- interval promotes together, and price_final reads the latest of them, so
  -- a correction posted before the deadline is the settlement value.
  with due as (
    select mp.market_id, mp.delivery_timestamp
    from public.market_prices mp
    where mp.product = 'RTM_HOURLY'
      and mp.is_final = false
      and public.ercot_price_final_at('RTM_HOURLY', mp.delivery_timestamp) <= clock_timestamp()
    group by mp.market_id, mp.delivery_timestamp
  )
  update public.market_prices mp
  set is_final = true
  from due
  where mp.market_id = due.market_id
    and mp.product = 'RTM_HOURLY'
    and mp.delivery_timestamp = due.delivery_timestamp;

  get diagnostics v_promoted = row_count;
  return v_promoted;
end;
$$;

revoke execute on function public.promote_rtm_finals() from public, anon, authenticated;
grant execute on function public.promote_rtm_finals() to service_role;

-- ---------------------------------------------------------------------
-- 4. Settlement waits for finality on the account's clock
-- ---------------------------------------------------------------------
do $$
declare
  v_fn regprocedure := 'public.settle_delivered_positions(timestamptz,integer,uuid)'::regprocedure;
  v_def text := pg_get_functiondef(v_fn);
  v_old text := 'and pos.delivery_end <= coalesce(p_as_of, public.sim_now(pos.user_id))';
  v_new text := 'and pos.delivery_end <= coalesce(p_as_of, public.sim_now(pos.user_id))'
    || E'\n      -- 0044: on an account''s clock, not before ERCOT''s prices are final.'
    || E'\n      and (p_as_of is not null'
    || E'\n           or public.position_final_at(pos.instrument, pos.product, pos.delivery_end)'
    || E'\n              <= public.sim_now(pos.user_id))';
begin
  if position('position_final_at' in v_def) > 0 then
    return; -- already applied
  end if;
  -- Both the sweep and its settlement_due_remaining count.
  if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 2 then
    raise exception '0044: expected two due tests in settle_delivered_positions';
  end if;
  execute replace(v_def, v_old, v_new);
end
$$;

-- ---------------------------------------------------------------------
-- 5. ERCOT's price corrections
-- ---------------------------------------------------------------------
create table if not exists public.ercot_price_correction_docs (
  doc_id              text primary key,
  report              text not null,
  posted_at           timestamptz not null,
  applied_at          timestamptz not null default now(),
  intervals_corrected integer not null default 0,
  hours_republished   integer not null default 0
);

alter table public.ercot_price_correction_docs enable row level security;
revoke all on table public.ercot_price_correction_docs from anon, authenticated;

-- p_rows: [{market_id, delivery_timestamp (15-minute interval start), price}]
create or replace function public.apply_rtm_price_corrections(
  p_doc_id text,
  p_posted_at timestamptz,
  p_source text,
  p_rows jsonb
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_intervals integer := 0;
  v_hours integer := 0;
  v_venue text;
  v_venue_hourly text;
begin
  if current_user <> 'service_role' then
    raise exception 'FORBIDDEN: apply_rtm_price_corrections is a service_role job';
  end if;
  if p_doc_id is null or p_posted_at is null or p_source is null
     or jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' then
    raise exception 'CORRECTION_INVALID';
  end if;

  -- Once per document; a concurrent run on the same one waits here, then
  -- finds it applied.
  insert into public.ercot_price_correction_docs (doc_id, report, posted_at)
  values (p_doc_id, 'NP4-197', p_posted_at)
  on conflict (doc_id) do nothing;
  if not found then
    return jsonb_build_object('applied', false, 'intervals', 0, 'hours', 0);
  end if;

  select venue into v_venue from public.products where code = 'RTM_15MIN';

  -- The corrected 15-minute prints, for intervals the store holds: a new
  -- observation each, published when ERCOT posted the correction.
  with input as (
    select distinct on (market_id, ts) market_id, ts, price
    from (
      select (r ->> 'market_id')::uuid as market_id,
             (r ->> 'delivery_timestamp')::timestamptz as ts,
             (r ->> 'price')::numeric as price
      from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
    ) x
    order by market_id, ts
  ),
  ins as (
    insert into public.market_prices (
      market_id, product, delivery_timestamp, delivery_end, price, venue,
      source, source_timestamp, published_at, is_final
    )
    select i.market_id, 'RTM_15MIN', i.ts, i.ts + interval '15 minutes', i.price, v_venue,
           p_source, p_posted_at, p_posted_at, false
    from input i
    where exists (
      select 1 from public.market_prices mp
      where mp.market_id = i.market_id
        and mp.product = 'RTM_15MIN'
        and mp.delivery_timestamp = i.ts
        and mp.published_at < p_posted_at
    )
    on conflict (market_id, product, delivery_timestamp, published_at) do nothing
    returning 1
  )
  select count(*) into v_intervals from ins;

  select venue into v_venue_hourly from public.products where code = 'RTM_HOURLY';

  -- Each hour now holding a corrected interval, re-averaged over its four
  -- intervals as of the correction (ERCOT's equal-time hourly rule, as the
  -- adapter aggregates it), for hours the store has an hourly price for.
  with hours as (
    select distinct mp.market_id, date_trunc('hour', mp.delivery_timestamp, 'UTC') as h
    from public.market_prices mp
    where mp.product = 'RTM_15MIN'
      and mp.published_at = p_posted_at
      and mp.source = p_source
      and (mp.market_id, mp.delivery_timestamp) in (
        select (r ->> 'market_id')::uuid, (r ->> 'delivery_timestamp')::timestamptz
        from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
      )
  ),
  quarters as (
    select hr.market_id, hr.h,
           (select mp.price
            from public.market_prices mp
            where mp.market_id = hr.market_id
              and mp.product = 'RTM_15MIN'
              and mp.delivery_timestamp = q.ts
              and mp.published_at <= p_posted_at
            order by case when mp.source like '%GENERATED%' then 1 else 0 end,
                     mp.published_at desc
            limit 1) as price
    from hours hr
    cross join lateral generate_series(hr.h, hr.h + interval '45 minutes', interval '15 minutes') q(ts)
    where exists (
      select 1 from public.market_prices mp
      where mp.market_id = hr.market_id
        and mp.product = 'RTM_HOURLY'
        and mp.delivery_timestamp = hr.h
    )
  ),
  ins as (
    insert into public.market_prices (
      market_id, product, delivery_timestamp, delivery_end, price, venue,
      source, source_timestamp, published_at, is_final
    )
    select market_id, 'RTM_HOURLY', h, h + interval '1 hour', round(avg(price), 4), v_venue_hourly,
           p_source, p_posted_at, p_posted_at, false
    from quarters
    group by market_id, h
    having count(price) = 4
    on conflict (market_id, product, delivery_timestamp, published_at) do nothing
    returning 1
  )
  select count(*) into v_hours from ins;

  update public.ercot_price_correction_docs
     set intervals_corrected = v_intervals,
         hours_republished = v_hours
   where doc_id = p_doc_id;

  return jsonb_build_object('applied', true, 'intervals', v_intervals, 'hours', v_hours);
end;
$$;

revoke execute on function public.apply_rtm_price_corrections(text, timestamptz, text, jsonb) from public, anon, authenticated;
grant execute on function public.apply_rtm_price_corrections(text, timestamptz, text, jsonb) to service_role;
