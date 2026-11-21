-- =====================================================================
-- 0058 — One statement of an account's credit, for the check and the Desk
--
-- What limits trading is the credit check in place_limit_order (0040, 0041,
-- 0043): every open bid, and every open margined position, holds MW x its
-- point's exposure factor, and with the new bid they must fit within cash,
-- less any open loss or deficit. That sum lived only inside the check. The
-- Desk shows account_margin, which counts filled positions alone, so a book
-- of open bids at its credit limit read "Initial margin $0.00, Available
-- $100,000, no open exposure" while every new bid was refused.
--
--   1. account_credit(user) states the limit, what bids and positions hold,
--      and what is left. The Desk reads it (service role, like
--      account_margin); no session may call it.
--   2. place_limit_order's check becomes "this bid's collateral exceeds what
--      is available": the same inequality, rearranged, so the Desk and the
--      check cannot drift apart again.
-- =====================================================================

create function public.account_credit(p_user_id uuid)
returns table (
  credit_limit numeric,
  bid_collateral numeric,
  position_collateral numeric,
  available_credit numeric,
  open_bids bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and not public.acts_for(p_user_id) then
    raise exception 'FORBIDDEN';
  end if;

  return query
  with bids as (
    select coalesce(sum(x.q * public.bid_exposure_factor(x.m)), 0) as held,
           coalesce(sum(x.n), 0)::bigint as n
    from (select o.market_id m, sum(o.quantity_mwh) q, count(*) n
          from public.paper_orders o
          where o.user_id = p_user_id and o.status = 'OPEN'
          group by o.market_id) x
  ),
  margined as (
    select coalesce(sum(abs(pos.quantity_mwh) * public.bid_exposure_factor(pos.market_id)), 0) as held
    from public.positions pos
    where pos.user_id = p_user_id and pos.quantity_mwh <> 0
      and public.is_margined_instrument(pos.instrument)
  ),
  lim as (
    -- 0043: an open loss or a deficit is already owed; a gain is not cash yet.
    select least(ac.cash_balance, (select mg.equity from public.account_margin(p_user_id) mg)) as v
    from public.paper_accounts ac
    where ac.user_id = p_user_id
  )
  select lim.v, bids.held, margined.held, lim.v - bids.held - margined.held, bids.n
  from lim, bids, margined;
end;
$$;

revoke execute on function public.account_credit(uuid) from public, anon, authenticated;
grant execute on function public.account_credit(uuid) to service_role;

comment on function public.account_credit(uuid) is
  'Credit limit (cash, less any open loss or deficit), collateral held by open bids and margined positions, and what is left for a new bid. place_limit_order refuses a bid whose collateral exceeds available_credit. Migration 0058.';

-- 2. The check, through it. The block is located by its first comment and
--    its exception, so the rest of 0057's body is untouched.
do $$
declare
  v_fn regprocedure :=
    'public.place_limit_order(uuid,uuid,text,text,uuid,text,numeric,numeric,timestamptz,timestamptz,timestamptz,text)'::regprocedure;
  v_def text := pg_get_functiondef(v_fn);
  v_start int := position('  -- 0040: collateral.' in v_def);
  v_raise int := position('CREDIT_LIMIT_EXCEEDED' in v_def);
  v_end int;
  v_check text :=
       E'  -- 0040/0041/0043, stated once in account_credit (0058): every open bid\n'
    || E'  -- and margined position holds MW x its point''s exposure factor, and\n'
    || E'  -- this bid must fit in what is left of cash, less any loss or deficit.\n'
    || E'  if p_quantity_mwh * public.bid_exposure_factor(p_market_id)\n'
    || E'     > (select c.available_credit from public.account_credit(p_user_id) c) then\n'
    || E'    raise exception ''CREDIT_LIMIT_EXCEEDED'';\n'
    || E'  end if;';
begin
  if position('account_credit' in v_def) > 0 then
    return; -- already applied
  end if;
  if v_start = 0 or v_raise < v_start then
    raise exception '0058: place_limit_order credit check not found';
  end if;
  v_end := v_raise + position('end if;' in substr(v_def, v_raise)) - 1 + length('end if;');
  execute substr(v_def, 1, v_start - 1) || v_check || substr(v_def, v_end);
  if position('CREDIT_LIMIT_EXCEEDED' in pg_get_functiondef(v_fn)) = 0
     or position('account_credit' in pg_get_functiondef(v_fn)) = 0 then
    raise exception '0058: place_limit_order credit check not replaced';
  end if;
end
$$;
