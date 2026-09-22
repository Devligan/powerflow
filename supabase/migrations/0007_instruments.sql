-- =====================================================================
-- PowerFlow — instrument catalog
--
-- Products (migration 0006) are *price series*: one settlement point, one
-- interval. Instruments are what a position is actually held in, and most of
-- what trades in ERCOT is not a single price series:
--
--   ENERGY       one leg, one interval (energy at a settlement point)
--   VIRTUAL      no delivery leg at all — a purely financial day-ahead
--                position that settles on the DA->RT convergence
--   DART_SPREAD  one location valued in two markets
--   BASIS_SPREAD two locations, same interval and market
--   PTP_SPREAD   source/sink path, obligation or option
--   AS_CAPACITY  one leg, capacity units ($/MW-hr)
--   CRR          auctioned congestion right
--   BLOCK_FORWARD / SWAP / OPTION
--                  period averages and optionality settled over the counter
--                  against ERCOT indices
--
-- OTC instruments carry a venue but no price series: they settle against the
-- ERCOT prices they reference, so no product is invented for them.
--
-- SCOPE NOTE: this migration makes every instrument *representable* and widens
-- the position identity so two instruments on the same point and interval
-- cannot collide. The execution engine that fills multi-leg shapes (legless
-- convergence trades, two-sided spreads, average-over-window blocks) lives in
-- migration 0008.
-- =====================================================================

-- ---------------------------------------------------------------------
-- instruments: the catalog
-- ---------------------------------------------------------------------
create table if not exists public.instruments (
  code text primary key,
  label text not null,
  kind text not null,
  venue text not null,
  -- 0 = legless financial, 1 = single point, 2 = point pair
  legs integer not null,
  settlement_rule text not null,
  option_type text not null default 'NONE',
  -- Single-leg instruments take their price product from the trade itself,
  -- because the same instrument shape can price energy or an ancillary service.
  product_from_trade boolean not null default false,
  tradable boolean not null default false,
  created_at timestamptz not null default now(),
  constraint instrument_kind_valid check (
    kind in (
      'ENERGY', 'VIRTUAL', 'DART_SPREAD', 'PTP_SPREAD', 'BASIS_SPREAD',
      'ANCILLARY', 'CRR', 'BLOCK_FORWARD', 'SWAP', 'OPTION'
    )
  ),
  constraint instrument_venue_valid check (
    venue in ('DAM', 'RTM', 'AS', 'CRR', 'OTC')
  ),
  constraint instrument_legs_valid check (legs in (0, 1, 2)),
  constraint instrument_rule_valid check (
    settlement_rule in ('POINT', 'DIFFERENCE', 'CONVERGENCE', 'AVERAGE')
  ),
  constraint instrument_option_valid check (
    option_type in ('NONE', 'OBLIGATION', 'OPTION')
  )
);

insert into public.instruments (
  code, label, kind, venue, legs, settlement_rule, option_type,
  product_from_trade, tradable
)
values
  -- ERCOT-cleared energy
  ('ENERGY_SPOT', 'Energy at a settlement point', 'ENERGY', 'RTM', 1, 'POINT', 'NONE', true, true),
  ('VIRTUAL', 'Virtual bid/offer (INC/DEC)', 'VIRTUAL', 'DAM', 0, 'CONVERGENCE', 'NONE', false, true),
  ('DART_SPREAD', 'Day-ahead vs real-time spread', 'DART_SPREAD', 'DAM', 1, 'CONVERGENCE', 'NONE', false, true),
  ('BASIS_SPREAD', 'Basis spread (point A vs point B)', 'BASIS_SPREAD', 'RTM', 2, 'DIFFERENCE', 'NONE', true, true),
  -- ERCOT-cleared congestion
  ('PTP_OBLIGATION', 'Point-to-point obligation', 'PTP_SPREAD', 'CRR', 2, 'DIFFERENCE', 'OBLIGATION', false, true),
  ('PTP_OPTION', 'Point-to-point option', 'PTP_SPREAD', 'CRR', 2, 'DIFFERENCE', 'OPTION', false, true),
  ('CRR_OBLIGATION', 'Congestion revenue right (obligation)', 'CRR', 'CRR', 2, 'DIFFERENCE', 'OBLIGATION', false, false),
  ('CRR_OPTION', 'Congestion revenue right (option)', 'CRR', 'CRR', 2, 'DIFFERENCE', 'OPTION', false, false),
  -- ERCOT-cleared capacity
  ('AS_CAPACITY', 'Ancillary service capacity', 'ANCILLARY', 'AS', 1, 'POINT', 'NONE', true, false),
  -- OTC / bilateral: settled against ERCOT indices, no series of their own
  ('BLOCK_FORWARD', 'Block forward (bal-day/week/month)', 'BLOCK_FORWARD', 'OTC', 1, 'AVERAGE', 'NONE', true, true),
  ('INDEX_SWAP', 'Fixed-for-floating index swap', 'SWAP', 'OTC', 1, 'AVERAGE', 'NONE', true, true),
  ('PRICE_OPTION', 'OTC price option', 'OPTION', 'OTC', 1, 'AVERAGE', 'OPTION', true, false)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------
-- trades / positions gain the instrument dimensions
-- ---------------------------------------------------------------------
-- NOTE on delivery_start/delivery_end: for single-interval instruments they
-- are the settlement interval; for AVERAGE instruments (block forwards, swaps)
-- they are the settlement *window*. Same columns, so there is no separate
-- window pair to keep in sync — and the position identity below covers both.
alter table public.trades
  add column if not exists instrument text not null default 'ENERGY_SPOT',
  -- Leg B of a path instrument (the sink); NULL for single-point and legless.
  add column if not exists counter_market_id uuid references public.markets (id);

alter table public.trades drop constraint if exists trade_instrument_fk;
alter table public.trades
  add constraint trade_instrument_fk foreign key (instrument)
  references public.instruments (code);

alter table public.positions
  add column if not exists instrument text not null default 'ENERGY_SPOT',
  add column if not exists counter_market_id uuid references public.markets (id);

alter table public.positions drop constraint if exists position_instrument_fk;
alter table public.positions
  add constraint position_instrument_fk foreign key (instrument)
  references public.instruments (code);

-- A unique constraint treats NULLs as distinct, so a nullable second leg would
-- let the same spread position be created twice instead of upserted. This
-- generated key flattens "no second leg" to the empty string so the widened
-- identity below dedupes both cases correctly.
alter table public.positions
  add column if not exists leg_key text
  generated always as (coalesce(counter_market_id::text, '')) stored;

-- Position identity now spans the instrument and both legs, so a day-ahead
-- position, a real-time position and a spread on the same point and interval
-- are three different positions.
alter table public.positions drop constraint if exists positions_identity_key;
alter table public.positions
  add constraint positions_identity_key
    unique (
      user_id, instrument, market_id, product, leg_key,
      delivery_start, delivery_end
    );

create index if not exists trades_user_instrument_idx
  on public.trades (user_id, instrument, created_at desc);

-- ---------------------------------------------------------------------
-- RLS + ACLs: instruments are public reference data
-- ---------------------------------------------------------------------
alter table public.instruments enable row level security;

drop policy if exists "instruments public read" on public.instruments;
create policy "instruments public read" on public.instruments
  for select to anon, authenticated using (true);

grant select on public.instruments to anon, authenticated;
