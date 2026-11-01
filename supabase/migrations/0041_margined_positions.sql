-- =====================================================================
-- 0041 — Virtuals and PTP obligations are backed by collateral, not cash
--
-- ERCOT never debits the notional of a virtual: a DEC of 100 MW at $50 does
-- not cost $5,000 up front, and an INC does not hand the trader $5,000. The
-- position is collateralised (0040 sizes that) and only its result — the
-- DA→RT spread times the MW — is ever paid. PowerFlow moved the full notional
-- through cash at entry and back at settlement: equity came out right, but
-- cash, buying power and the exposure cap all read as if the trader had
-- bought physical power.
--
-- A margined instrument is one that settles DA→RT (CONVERGENCE,
-- CONGESTION_CONVERGENCE: VIRTUAL, DART_SPREAD, PTP obligations/options).
-- For those:
--   * execute_trade moves cash by realized P&L only (none on opening), and
--     skips the cash-cover and gross-notional checks — collateral at bid
--     time is what limits them;
--   * settle_delivered_positions pays or collects (RT − entry) × MW;
--   * liquidate_to_fund never picks one (closing it frees no cash);
--   * account_margin and get_leaderboard value it at qty × (mark − entry),
--     its P&L (get_leaderboard also stops counting shorts as assets: it
--     summed mark × |qty|);
--   * place_limit_order's credit check also counts open margined positions'
--     collateral.
-- Every other instrument is unchanged. No margined position was open when
-- this was applied, so no balance needed converting.
--
-- Each function body is patched in place (as 0028/0037/0038 did) and every
-- patch is checked: missing text fails the migration; a re-run is a no-op.
-- =====================================================================

create or replace function public.is_margined_instrument(p_code text)
returns boolean
language sql
stable
set search_path = public
as $$
  select coalesce(
    (select settlement_rule in ('CONVERGENCE', 'CONGESTION_CONVERGENCE')
     from public.instruments where code = p_code),
    false)
$$;

revoke execute on function public.is_margined_instrument(text) from public, anon;
grant execute on function public.is_margined_instrument(text) to authenticated, service_role;

do $$
declare
  r record;
  v_def text;
begin
  for r in
    select * from (values
      -- execute_trade: no cash cover, no notional cap, cash moves by P&L.
      ('public.execute_trade(uuid,uuid,uuid,text,text,text,numeric,timestamptz,timestamptz,text)'::regprocedure,
       E'  if p_side = ''BUY'' and v_notional > v_account.cash_balance then',
       E'  if p_side = ''BUY'' and v_notional > v_account.cash_balance\n     and not public.is_margined_instrument(v_instr.code) then'),
      ('public.execute_trade(uuid,uuid,uuid,text,text,text,numeric,timestamptz,timestamptz,text)'::regprocedure,
       E'  if v_gross_new > v_account.max_gross_notional then',
       E'  if v_gross_new > v_account.max_gross_notional\n     and not public.is_margined_instrument(v_instr.code) then'),
      ('public.execute_trade(uuid,uuid,uuid,text,text,text,numeric,timestamptz,timestamptz,text)'::regprocedure,
       E'  -- 10. Cash moves with the trade.\n  if p_side = ''BUY'' then',
       E'  -- 10. Cash moves with the trade. A margined position (0041) is backed by\n'
       || E'  --     collateral, not cash: only the P&L it realizes moves the balance.\n'
       || E'  if public.is_margined_instrument(v_instr.code) then\n'
       || E'    update public.paper_accounts\n'
       || E'       set cash_balance = cash_balance + v_realized_delta, updated_at = v_exec_at\n'
       || E'     where id = v_account.id;\n'
       || E'  elsif p_side = ''BUY'' then'),
      -- settlement: P&L only.
      ('public.settle_delivered_positions(timestamptz,integer,uuid)'::regprocedure,
       E'      v_notional := v_price * v_pos.quantity_mwh;',
       E'      -- 0041: a margined position settles its P&L only; it never put up cash.\n'
       || E'      v_notional := case when public.is_margined_instrument(v_pos.instrument)\n'
       || E'                         then (v_price - v_pos.average_entry_price) * v_pos.quantity_mwh\n'
       || E'                         else v_price * v_pos.quantity_mwh end;'),
      -- liquidation: margined positions free no cash.
      ('public.liquidate_to_fund(uuid,numeric,timestamptz,uuid)'::regprocedure,
       E'      and pos.settled_at is null\n      and (p_exclude_position_id is null or pos.id <> p_exclude_position_id)',
       E'      and pos.settled_at is null\n'
       || E'      -- 0041: closing a margined position frees no cash.\n'
       || E'      and not public.is_margined_instrument(pos.instrument)\n'
       || E'      and (p_exclude_position_id is null or pos.id <> p_exclude_position_id)'),
      -- equity: margined positions at their P&L.
      ('public.account_margin(uuid)'::regprocedure,
       E'      sum(p.quantity_mwh * m.mark) filter (where m.mark is not null) as marked_value,',
       E'      -- 0041: a margined position is worth its P&L, not its notional.\n'
       || E'      sum(p.quantity_mwh * (m.mark - case when public.is_margined_instrument(p.instrument)\n'
       || E'                                          then p.average_entry_price else 0 end))\n'
       || E'        filter (where m.mark is not null) as marked_value,'),
      ('public.get_leaderboard(integer)'::regprocedure,
       E'           sum(mark.mark_price * abs(pos.quantity_mwh)) as marked_value,',
       E'           -- 0041: signed (a short is a liability), and a margined position\n'
       || E'           -- counts its P&L only.\n'
       || E'           sum(pos.quantity_mwh * (mark.mark_price - case when public.is_margined_instrument(pos.instrument)\n'
       || E'                                                    then pos.average_entry_price else 0 end)) as marked_value,'),
      -- credit: open margined positions hold collateral too.
      ('public.place_limit_order(uuid,uuid,text,text,uuid,text,numeric,numeric,timestamptz,timestamptz,timestamptz)'::regprocedure,
       E'     + p_quantity_mwh * public.bid_exposure_factor(p_market_id)\n',
       E'     + p_quantity_mwh * public.bid_exposure_factor(p_market_id)\n'
       || E'     -- 0041: every open margined position holds its collateral too.\n'
       || E'     + (select coalesce(sum(abs(pos.quantity_mwh) * public.bid_exposure_factor(pos.market_id)), 0)\n'
       || E'        from public.positions pos\n'
       || E'        where pos.user_id = p_user_id and pos.quantity_mwh <> 0\n'
       || E'          and public.is_margined_instrument(pos.instrument))\n')
    ) as t(fn, old_text, new_text)
  loop
    v_def := pg_get_functiondef(r.fn);
    if position(r.new_text in v_def) > 0 then
      continue; -- already applied
    end if;
    if position(r.old_text in v_def) = 0 then
      raise exception '0041: expected text not found in %: %', r.fn, left(r.old_text, 80);
    end if;
    execute replace(v_def, r.old_text, r.new_text);
  end loop;
end
$$;
