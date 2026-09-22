-- =====================================================================
-- PowerFlow — core schema (Phase 1)
-- Profiles, paper accounts, markets, prices, trades, positions,
-- audit events, ingress runs. RLS on every private table.
-- =====================================================================

-- ---------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique,
  display_name text,
  avatar_url text,
  leaderboard_opt_in boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint username_format check (username ~ '^[a-z0-9_]{3,30}$')
);

-- ---------------------------------------------------------------------
-- paper_accounts
-- ---------------------------------------------------------------------
create table if not exists public.paper_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  starting_cash numeric not null,
  cash_balance numeric not null,
  -- Configurable virtual exposure / margin limit (dollars of gross notional).
  max_gross_notional numeric not null default 500000,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint starting_cash_nonneg check (starting_cash >= 0),
  constraint cash_balance_nonneg check (cash_balance >= 0),
  constraint max_gross_notional_positive check (max_gross_notional > 0)
);

-- ---------------------------------------------------------------------
-- markets
-- ---------------------------------------------------------------------
create table if not exists public.markets (
  id uuid primary key default gen_random_uuid(),
  settlement_point text not null unique,
  settlement_point_type text not null,
  description text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint settlement_point_type_valid check (
    settlement_point_type in ('HUB', 'LOAD_ZONE', 'SETTLEMENT_POINT')
  )
);

-- ---------------------------------------------------------------------
-- market_prices
-- ---------------------------------------------------------------------
create table if not exists public.market_prices (
  id uuid primary key default gen_random_uuid(),
  market_id uuid not null references public.markets (id) on delete cascade,
  delivery_timestamp timestamptz not null,
  -- optional explicit interval end; defaults to +1h for the RTH product
  delivery_end timestamptz,
  price numeric not null,
  -- market product; RTH = Real-Time Hourly Average (the MVP product)
  product text not null default 'RTH',
  source text not null default 'ERCOT_MIS',
  source_timestamp timestamptz,
  ingested_at timestamptz not null default now(),
  constraint market_price_positive_window check (
    delivery_end is null or delivery_end > delivery_timestamp
  ),
  constraint market_price_sane check (price > -2000 and price < 20000),
  constraint market_price_product_valid check (product in ('RTH')),
  -- Idempotency: the uniqueness constraint is the final duplicate guard.
  constraint market_prices_market_delivery_product_key
    unique (market_id, delivery_timestamp, product)
);

create index if not exists market_prices_market_delivery_idx
  on public.market_prices (market_id, delivery_timestamp desc);

-- ---------------------------------------------------------------------
-- trades  (immutable historical events)
-- ---------------------------------------------------------------------
create table if not exists public.trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  market_id uuid not null references public.markets (id),
  side text not null,
  quantity_mwh numeric not null,
  delivery_start timestamptz not null,
  delivery_end timestamptz not null,
  execution_price numeric not null,
  -- delivery_timestamp of the authoritative persisted market price used
  price_timestamp timestamptz not null,
  market_price_id uuid not null references public.market_prices (id),
  status text not null default 'EXECUTED',
  created_at timestamptz not null default now(),
  executed_at timestamptz not null default now(),
  constraint side_valid check (side in ('BUY', 'SELL')),
  constraint trade_status_valid check (status in ('EXECUTED', 'REJECTED')),
  constraint trade_qty_positive check (quantity_mwh > 0),
  constraint trade_delivery_ordered check (delivery_end > delivery_start),
  constraint trade_execution_price_sane check (
    execution_price > -2000 and execution_price < 20000
  )
);

create index if not exists trades_user_created_idx
  on public.trades (user_id, created_at desc);
create index if not exists trades_user_market_idx
  on public.trades (user_id, market_id);

-- ---------------------------------------------------------------------
-- positions  (aggregate exposure, only the trade engine mutates)
-- ---------------------------------------------------------------------
create table if not exists public.positions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  market_id uuid not null references public.markets (id),
  delivery_start timestamptz not null,
  delivery_end timestamptz not null,
  quantity_mwh numeric not null default 0,
  average_entry_price numeric not null default 0,
  realized_pnl numeric not null default 0,
  updated_at timestamptz not null default now(),
  constraint position_delivery_ordered check (delivery_end > delivery_start),
  -- position identity
  constraint positions_identity_key
    unique (user_id, market_id, delivery_start, delivery_end)
);

create index if not exists positions_user_market_idx
  on public.positions (user_id, market_id);

-- ---------------------------------------------------------------------
-- audit_events  (immutable)
-- ---------------------------------------------------------------------
create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  event_type text not null,
  entity_type text not null,
  entity_id uuid,
  metadata jsonb,
  created_at timestamptz not null default now(),
  constraint audit_event_type_valid check (
    event_type in (
      'USER_CREATED',
      'ACCOUNT_CREATED',
      'TRADE_CREATED',
      'TRADE_VALIDATED',
      'TRADE_EXECUTED',
      'TRADE_REJECTED',
      'POSITION_UPDATED',
      'PROFILE_UPDATED',
      'LEADERBOARD_OPT_IN_CHANGED'
    )
  )
);

create index if not exists audit_events_user_created_idx
  on public.audit_events (user_id, created_at desc);

-- ---------------------------------------------------------------------
-- ingestion_runs  (observability for the market-data pipeline)
-- ---------------------------------------------------------------------
create table if not exists public.ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'RUNNING',
  records_received integer not null default 0,
  records_inserted integer not null default 0,
  records_skipped integer not null default 0,
  error_message text,
  detail jsonb,
  constraint ingestion_status_valid check (
    status in ('RUNNING', 'SUCCESS', 'FAILED')
  )
);

create index if not exists ingestion_runs_started_idx
  on public.ingestion_runs (started_at desc);

-- ---------------------------------------------------------------------
-- updated_at helper + triggers
-- ---------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_profiles_set_updated_at on public.profiles;
create trigger trg_profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists trg_paper_accounts_set_updated_at on public.paper_accounts;
create trigger trg_paper_accounts_set_updated_at
  before update on public.paper_accounts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- Immutability guards: nothing may mutate executed trades or audit events,
-- even through the service role. Trades are append-only.
-- ---------------------------------------------------------------------
create or replace function public.prevent_trade_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'trades are immutable' using errcode = 'TRADE';
end;
$$;

drop trigger if exists trg_trades_immutable on public.trades;
create trigger trg_trades_immutable
  before update or delete on public.trades
  for each row execute function public.prevent_trade_mutation();

create or replace function public.prevent_audit_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit events are immutable' using errcode = 'AUDIT';
end;
$$;

drop trigger if exists trg_audit_immutable on public.audit_events;
create trigger trg_audit_immutable
  before update or delete on public.audit_events
  for each row execute function public.prevent_audit_mutation();

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.paper_accounts enable row level security;
alter table public.markets enable row level security;
alter table public.market_prices enable row level security;
alter table public.trades enable row level security;
alter table public.positions enable row level security;
alter table public.audit_events enable row level security;
alter table public.ingestion_runs enable row level security;

-- Public market data (read-only for everyone).
create policy "markets public read" on public.markets
  for select to anon, authenticated using (true);
create policy "market_prices public read" on public.market_prices
  for select to anon, authenticated using (true);

-- Profiles: users manage their own row only.
drop policy if exists "profiles own select" on public.profiles;
create policy "profiles own select" on public.profiles
  for select to authenticated using (auth.uid() = id);
drop policy if exists "profiles own insert" on public.profiles;
create policy "profiles own insert" on public.profiles
  for insert to authenticated with check (auth.uid() = id);
drop policy if exists "profiles own update" on public.profiles;
create policy "profiles own update" on public.profiles
  for update to authenticated using (auth.uid() = id)
  with check (auth.uid() = id);

-- Paper accounts: read-only for the owner. Cash is mutated only by the
-- server-side trade engine (SECURITY DEFINER).
drop policy if exists "paper_accounts own select" on public.paper_accounts;
create policy "paper_accounts own select" on public.paper_accounts
  for select to authenticated using (user_id = auth.uid());

-- Trades: read own history only. No insert/update/delete policies.
drop policy if exists "trades own select" on public.trades;
create policy "trades own select" on public.trades
  for select to authenticated using (user_id = auth.uid());

-- Positions: read own positions only.
drop policy if exists "positions own select" on public.positions;
create policy "positions own select" on public.positions
  for select to authenticated using (user_id = auth.uid());

-- Audit events: read own audit trail only.
drop policy if exists "audit_events own select" on public.audit_events;
create policy "audit_events own select" on public.audit_events
  for select to authenticated using (user_id = auth.uid());

-- Ingestion runs: read-only transparency for all authenticated users.
drop policy if exists "ingestion_runs read" on public.ingestion_runs;
create policy "ingestion_runs read" on public.ingestion_runs
  for select to authenticated using (true);

-- ---------------------------------------------------------------------
-- Account bootstrapping
-- ---------------------------------------------------------------------
create or replace function public.mint_username(p_email text, p_user_id uuid)
returns text
language plpgsql
as $$
declare
  v_base text;
  v_candidate text;
begin
  v_base := lower(
    regexp_replace(split_part(coalesce(p_email, ''), '@', 1), '[^a-z0-9_]', '', 'g')
  );
  if v_base is null or length(v_base) < 3 then
    v_base := 'trader';
  end if;
  v_base := left(v_base, 20);

  if not exists (select 1 from public.profiles where username = v_base) then
    return v_base;
  end if;

  v_candidate := v_base || '_' || substr(md5(p_user_id::text), 1, 6);
  return v_candidate;
end;
$$;

-- Trigger: create profile + paper account + audit trail when a user signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username, display_name, avatar_url)
  values (
    new.id,
    public.mint_username(new.email, new.id),
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      split_part(coalesce(new.email, ''), '@', 1)
    ),
    coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture')
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

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Idempotent bootstrap for pre-existing users / repeated logins. Never resets
-- an existing account (ON CONFLICT DO NOTHING).
create or replace function public.ensure_user_records(p_user_id uuid, p_email text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := coalesce(p_email, '');
begin
  insert into public.profiles (id, username)
  values (p_user_id, public.mint_username(v_email, p_user_id))
  on conflict (id) do nothing;

  insert into public.paper_accounts (user_id, starting_cash, cash_balance)
  values (p_user_id, 100000, 100000)
  on conflict (user_id) do nothing;

  insert into public.audit_events (user_id, event_type, entity_type, entity_id, metadata)
  values (p_user_id, 'USER_CREATED', 'user', p_user_id, jsonb_build_object('email', v_email))
  on conflict do nothing;
end;
$$;

-- ---------------------------------------------------------------------
-- Latest price view for the Markets UI
-- ---------------------------------------------------------------------
create or replace view public.current_prices as
select distinct on (m.id)
  m.id as market_id,
  m.settlement_point,
  m.settlement_point_type,
  m.description,
  m.active,
  mp.delivery_timestamp,
  mp.delivery_end,
  mp.price,
  mp.product,
  mp.source,
  mp.ingested_at
from public.markets m
left join public.market_prices mp on mp.market_id = m.id
order by m.id, mp.delivery_timestamp desc nulls last;

grant usage on schema public to anon, authenticated, service_role;
grant select on public.markets, public.market_prices to anon, authenticated;
grant execute on function public.mint_username(text, uuid) to authenticated;
grant execute on function public.ensure_user_records(uuid, text) to authenticated;

-- Latest stored delivery timestamp per market (drives the ingestion window).
create or replace function public.latest_price_timestamps(p_market_ids uuid[])
returns table (market_id uuid, delivery_timestamp timestamptz)
language sql
stable
as $$
  select distinct on (mp.market_id) mp.market_id, mp.delivery_timestamp
  from public.market_prices mp
  where mp.market_id = any(p_market_ids)
  order by mp.market_id, mp.delivery_timestamp desc;
$$;
grant execute on function public.latest_price_timestamps(uuid[]) to authenticated;