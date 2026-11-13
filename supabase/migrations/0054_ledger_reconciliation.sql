-- =====================================================================
-- 0054 — The ledger reconciles itself, every hour
--
-- Every money movement goes through a handful of definer functions, and the
-- DB suites pin each one. What nothing checked is the books as a whole, after
-- months of fills, settlements, liquidations and deficits on real accounts:
-- a bug in any one path (or a hand edit) would leave a balance that no longer
-- follows from its trades, and the first sign would be a trader noticing.
--
-- ledger_violations() states what must hold of the stored ledger and returns
-- every row that breaks it. It is one SQL statement, so it reads one snapshot:
-- a fill landing mid-check cannot show up as a half-applied trade.
--
--   cash_reconciles        cash − deficit = starting cash + every fill's cash
--                          flow. A fill moves −p×q on a buy and +p×q on a sell;
--                          a margined instrument (0041) moves only the P&L it
--                          realizes, which is exactly what its positions'
--                          realized_pnl accumulates. Settlement, liquidation
--                          and deficit repayment change cash and deficit
--                          together (0014), so they cancel out of the left
--                          side. Compared at the app's money scale (1e-6
--                          dollars): a weighted-average entry is a numeric
--                          division, carried to 16+ digits, not infinitely.
--   positions_match_trades every position's quantity is the signed sum of the
--                          fills with its identity, and no fills net to a
--                          quantity that has no position.
--   settlements_trace      a settled position's settlement trade is the
--                          account's own SETTLED fill of the same instrument,
--                          market and window. (That it is flat and has one is
--                          already a constraint, position_settlement_state.)
--   fills_match_orders     a FILLED bid names its trade and an unfilled one
--                          names none; the trade is the bid's account, side,
--                          size, market, instrument and window.
--   fills_audited          every fill has its TRADE_EXECUTED audit event.
--
-- record_ledger_audit() runs it, keeps the counts plus a few sample rows in
-- ledger_audits, and pg_cron calls it hourly at :40, after the :25 settlement
-- sweep. The public status route reports the newest result (counts only) and
-- the Production workflow fails when a check does. Housekeeping keeps 30 days.
--
-- The DB suites call ledger_violations() for every account they create before
-- tearing it down, so each engine test also proves the books still balance.
-- =====================================================================

create table if not exists public.ledger_audits (
  id bigint generated always as identity primary key,
  checked_at timestamptz not null default now(),
  ok boolean not null,
  -- [{ "check": text, "violations": int, "sample": [...] }]
  checks jsonb not null,
  accounts int not null,
  trades int not null,
  duration_ms numeric not null
);

create index if not exists ledger_audits_checked_at_idx
  on public.ledger_audits (checked_at desc);

-- Service role only: samples name accounts.
alter table public.ledger_audits enable row level security;
revoke all on public.ledger_audits from public, anon, authenticated;
grant select, insert, delete on public.ledger_audits to service_role;

create or replace function public.ledger_violations(p_user_ids uuid[] default null)
returns table (check_name text, user_id uuid, entity_id uuid, detail jsonb)
language sql
stable
security definer
set search_path = public
as $$
  with accts as (
    select a.* from public.paper_accounts a
    where p_user_ids is null or a.user_id = any(p_user_ids)
  ),
  fills as (
    select t.*,
           coalesce(i.settlement_rule in ('CONVERGENCE', 'CONGESTION_CONVERGENCE'), false) as margined
    from public.trades t
    left join public.instruments i on i.code = t.instrument
    where t.status <> 'REJECTED'
      and (p_user_ids is null or t.user_id = any(p_user_ids))
  ),
  pos as (
    select p.*,
           coalesce(i.settlement_rule in ('CONVERGENCE', 'CONGESTION_CONVERGENCE'), false) as margined
    from public.positions p
    left join public.instruments i on i.code = p.instrument
    where p_user_ids is null or p.user_id = any(p_user_ids)
  ),
  cash as (
    select a.user_id, a.id as account_id, a.starting_cash, a.cash_balance, a.deficit,
           a.starting_cash
             + coalesce((select sum(case when f.side = 'SELL' then f.execution_price * f.quantity_mwh
                                         else -(f.execution_price * f.quantity_mwh) end)
                         from fills f where f.user_id = a.user_id and not f.margined), 0)
             + coalesce((select sum(p.realized_pnl)
                         from pos p where p.user_id = a.user_id and p.margined), 0)
             as expected
    from accts a
  ),
  netted as (
    select f.user_id, f.instrument, f.market_id, coalesce(f.counter_market_id::text, '') as leg_key,
           f.product, f.delivery_start, f.delivery_end,
           sum(case when f.side = 'BUY' then f.quantity_mwh else -f.quantity_mwh end) as quantity
    from fills f
    group by 1, 2, 3, 4, 5, 6, 7
  )
  select 'cash_reconciles', c.user_id, c.account_id,
         jsonb_build_object('cash', c.cash_balance, 'deficit', c.deficit,
                            'expected', c.expected,
                            'gap', (c.cash_balance - c.deficit) - c.expected)
  from cash c
  where abs((c.cash_balance - c.deficit) - c.expected) >= 0.000001

  union all
  select 'positions_match_trades', coalesce(p.user_id, n.user_id), p.id,
         jsonb_build_object('position_quantity', p.quantity_mwh, 'fills_net', coalesce(n.quantity, 0),
                            'instrument', coalesce(p.instrument, n.instrument),
                            'delivery_start', coalesce(p.delivery_start, n.delivery_start))
  from pos p
  full join netted n
    on n.user_id = p.user_id and n.instrument = p.instrument and n.market_id = p.market_id
   and n.leg_key = p.leg_key and n.product = p.product
   and n.delivery_start = p.delivery_start and n.delivery_end = p.delivery_end
  where coalesce(p.quantity_mwh, 0) <> coalesce(n.quantity, 0)

  union all
  select 'settlements_trace', p.user_id, p.id,
         jsonb_build_object('settlement_trade_id', p.settlement_trade_id, 'trade_status', t.status,
                            'same_account', t.user_id = p.user_id)
  from pos p
  left join public.trades t on t.id = p.settlement_trade_id
  where p.settlement_trade_id is not null
    and (t.id is null or t.status <> 'SETTLED' or t.user_id <> p.user_id
         or t.instrument <> p.instrument or t.market_id <> p.market_id
         or t.delivery_start <> p.delivery_start or t.delivery_end <> p.delivery_end)

  union all
  select 'fills_match_orders', o.user_id, o.id,
         jsonb_build_object('status', o.status, 'filled_trade_id', o.filled_trade_id)
  from public.paper_orders o
  left join public.trades t on t.id = o.filled_trade_id
  where (p_user_ids is null or o.user_id = any(p_user_ids))
    and ((o.status = 'FILLED') <> (o.filled_trade_id is not null)
         or (o.filled_trade_id is not null
             and (t.id is null
                  or t.user_id <> o.user_id or t.side <> o.side or t.quantity_mwh <> o.quantity_mwh
                  or t.market_id <> o.market_id or t.instrument <> o.instrument
                  or t.delivery_start <> o.delivery_start or t.delivery_end <> o.delivery_end)))

  union all
  select 'fills_audited', f.user_id, f.id,
         jsonb_build_object('executed_at', f.executed_at, 'instrument', f.instrument)
  from fills f
  where f.status = 'EXECUTED'
    and not exists (
      select 1 from public.audit_events e
      where e.user_id = f.user_id and e.event_type = 'TRADE_EXECUTED' and e.entity_id = f.id)
$$;

revoke execute on function public.ledger_violations(uuid[]) from public, anon, authenticated;
grant execute on function public.ledger_violations(uuid[]) to service_role;

create or replace function public.record_ledger_audit()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_started timestamptz := clock_timestamp();
  v_checks jsonb;
  v_ok boolean;
  v_row public.ledger_audits;
begin
  -- Every check is listed, clean ones with zero, so a check that silently
  -- stopped running is visible as missing rather than as passing.
  with found as (
    select lv.*, row_number() over (partition by lv.check_name order by lv.user_id, lv.entity_id) as rn
    from public.ledger_violations() lv
  ),
  per_check as (
    select f.check_name, count(*)::int as n,
           jsonb_agg(jsonb_build_object('user_id', f.user_id, 'entity_id', f.entity_id, 'detail', f.detail))
             filter (where f.rn <= 5) as sample
    from found f
    group by f.check_name
  )
  select jsonb_agg(jsonb_build_object(
           'check', c.name,
           'violations', coalesce(v.n, 0),
           'sample', coalesce(v.sample, '[]'::jsonb)) order by c.ord)
    into v_checks
  from unnest(array['cash_reconciles', 'positions_match_trades', 'settlements_trace',
                    'fills_match_orders', 'fills_audited']) with ordinality as c(name, ord)
  left join per_check v on v.check_name = c.name;

  v_ok := not exists (select 1 from jsonb_array_elements(v_checks) e where (e ->> 'violations')::int > 0);

  insert into public.ledger_audits (ok, checks, accounts, trades, duration_ms)
  values (
    v_ok, v_checks,
    (select count(*) from public.paper_accounts),
    (select count(*) from public.trades),
    round(extract(epoch from clock_timestamp() - v_started) * 1000, 1))
  returning * into v_row;

  return to_jsonb(v_row);
end;
$$;

revoke execute on function public.record_ledger_audit() from public, anon, authenticated;
grant execute on function public.record_ledger_audit() to service_role;

-- 0050's housekeeping, restated with the audit history added.
create or replace function public.housekeeping()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_runs int;
  v_limits int;
  v_audits int;
  v_cron int := 0;
begin
  delete from public.ingestion_runs where started_at < now() - interval '90 days';
  get diagnostics v_runs = row_count;
  -- The longest limit window is an hour.
  delete from public.rate_limits where window_start < now() - interval '1 day';
  get diagnostics v_limits = row_count;
  delete from public.ledger_audits where checked_at < now() - interval '30 days';
  get diagnostics v_audits = row_count;
  if to_regclass('cron.job_run_details') is not null then
    delete from cron.job_run_details where end_time < now() - interval '14 days';
    get diagnostics v_cron = row_count;
  end if;
  return jsonb_build_object('ingestion_runs', v_runs, 'rate_limits', v_limits,
                            'ledger_audits', v_audits, 'cron_runs', v_cron);
end;
$$;

revoke execute on function public.housekeeping() from public, anon, authenticated;
grant execute on function public.housekeeping() to service_role;

-- cron.schedule replaces a job of the same name, so re-running is safe.
select cron.schedule('powerflow-ledger-audit', '40 * * * *', $$select public.record_ledger_audit()$$);

-- The first result, so the status route has one the moment this is applied.
select public.record_ledger_audit();
