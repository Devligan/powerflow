import crypto from 'crypto';

// The probe reads its secrets from the environment. The RUNME block in
// scripts/settlement-probe-runme.ps1 sources .env into the process environment
// before invoking tsx so the file paths and key names stay in one place.
const u = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, '') ?? '';
const k = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

if (!u || !k) {
  // Keep the message actionable: it names the exact env vars and the loader
  // that is supposed to set them, and it does not leak any actual value.
  throw new Error(
    'scripts/settlement-probe.ts: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. ' +
    'Run scripts/settlement-probe-runme.ps1 (or source .env into the environment yourself) before calling tsx.'
  );
}

async function rawRpc<T>(fn: string, body: Record<string, unknown>): Promise<{ status: number; error?: unknown; data?: T }> {
  const resp = await fetch(`${u}/rest/v1/rpc/${encodeURIComponent(fn)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: k,
      authorization: `Bearer ${k}`,
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (resp.status >= 400) {
    return { status: resp.status, error: JSON.parse(text || 'null') ?? text };
  }
  try {
    return { status: resp.status, data: JSON.parse(text) as T };
  } catch {
    return { status: resp.status, data: text as unknown as T };
  }
}

// Resolve a real HB_HOUSTON market id from the live DB so the probe trades on
// a real active market rather than a guessed UUID.
let mid = 'b8f78f92-9e40-4a5e-9eaa-49e9b25242af';
async function resolveMid() {
  try {
    const markets = await fetch(`${u}/rest/v1/markets?select=id,settlement_point&settlement_point=eq.HB_HOUSTON`, {
      headers: { apikey: k, authorization: `Bearer ${k}` },
    }).then(r => r.json());
    if (Array.isArray(markets) && markets.length) mid = markets[0].id;
  } catch (e) {
    console.warn('market lookup failed, using fallback mid', e);
  }
}

async function buildDeliveryWindows() {
  const now = new Date();
  const deliveryStart = new Date(now.getTime() + 5 * 3600_000).toISOString().replace(/\.\d+Z$/, 'Z');
  const deliveryEnd = new Date(now.getTime() + 6 * 3600_000).toISOString().replace(/\.\d+Z$/, 'Z');
  return { deliveryStart, deliveryEnd };
}

async function main(deliveryStart: string, deliveryEnd: string) {
  console.log('deliveryStart', deliveryStart, 'deliveryEnd', deliveryEnd);
  // 1. grab a user
  const users = await fetch(`${u}/rest/v1/paper_accounts?select=user_id,starting_cash,cash_balance&limit=3`, {
    headers: { apikey: k, authorization: `Bearer ${k}` },
  }).then(r => r.json());
  console.log('paper_accounts', Array.isArray(users) ? users.length : users);
  let uid = null;
  if (Array.isArray(users) && users.length) uid = users[0].user_id;
  console.log('uid', uid);
  if (!uid) { console.log('no user, stopping'); return; }

  // 2. execute a real trade with a future delivery interval (dedup-safe client id)
  const t = await rawRpc('execute_trade', {
    p_user_id: uid,
    p_market_id: mid,
    p_counter_market_id: null,
    p_instrument: 'ENERGY_SPOT',
    p_product: 'DAM_HOURLY',
    p_side: 'BUY',
    p_quantity_mwh: 1,
    p_delivery_start: deliveryStart,
    p_delivery_end: deliveryEnd,
    p_client_order_id: 'probe-' + crypto.randomUUID(),
  });
  console.log('execute_trade', t.status, JSON.stringify(t.error ?? t.data).slice(0, 600));
  if (/DELIVERY_MUST_BE_ALIGNED/.test(String((t.data as { message?: string } | null)?.message ?? ''))) {
    console.log('NOTE: delivery window is not aligned to the product interval; retrying with floored windows');
    const fs = Math.floor(new Date(deliveryStart).getTime() / (60 * 1000)) * (60 * 1000);
    const fe = fs + 3600_000;
    const alignedStart = new Date(fs).toISOString();
    const alignedEnd = new Date(fe).toISOString();
    const t2 = await rawRpc('execute_trade', {
      p_user_id: uid,
      p_market_id: mid,
      p_counter_market_id: null,
      p_instrument: 'ENERGY_SPOT',
      p_product: 'DAM_HOURLY',
      p_side: 'BUY',
      p_quantity_mwh: 1,
      p_delivery_start: alignedStart,
      p_delivery_end: alignedEnd,
      p_client_order_id: 'probe-aligned-' + crypto.randomUUID(),
    });
    console.log('execute_trade(aligned)', t2.status, JSON.stringify(t2.error ?? t2.data).slice(0, 600));
  }

  // 3. confirm the position exists (only if the trade succeeded)
  let posAfterTrade = null;
  if (t.status === 200 && t.data) {
    posAfterTrade = await fetch(`${u}/rest/v1/positions?select=id,instrument,market_id,product,delivery_start,delivery_end,quantity_mwh,average_entry_price,realized_pnl&user_id=eq.${uid}`, {
      headers: { apikey: k, authorization: `Bearer ${k}` },
    }).then(r => r.json());
    console.log('positions after trade', Array.isArray(posAfterTrade) ? posAfterTrade.length : posAfterTrade, posAfterTrade);
  } else {
    console.log('trade did not succeed; skipping position read');
  }

  // 4. try set_sim_clock to advance clock past delivery end
  const sn1 = await rawRpc('set_sim_clock', { p_user_id: uid, p_iso: deliveryEnd });
  console.log('sim_now set', sn1.status, JSON.stringify(sn1.error ?? sn1.data).slice(0, 400));

  // 5. settle — only if the trade is open and delivered
  let s1 = null;
  if (t.status === 200 && t.data) {
    s1 = await rawRpc('settle_delivered_positions', { p_user_id: uid, p_as_of: deliveryEnd });
    console.log('settle', s1.status, JSON.stringify(s1.error ?? s1.data).slice(0, 600));

    // 6. marks — only if settle ran
    const m1raw = await rawRpc<Array<{ position_id: string; mark_price: number }>>('position_marks', { p_user_id: uid });
    console.log('marks', m1raw.status, JSON.stringify(m1raw.error ?? (m1raw.data ?? [])).slice(0, 600));
  }

  // 7. positions/trades/account after settle — only if trade executed
  if (t.status === 200 && t.data) {
    const pos2 = await fetch(`${u}/rest/v1/positions?select=id,instrument,market_id,product,delivery_start,delivery_end,quantity_mwh,average_entry_price,realized_pnl&user_id=eq.${uid}`, {
      headers: { apikey: k, authorization: `Bearer ${k}` },
    }).then(r => r.json());
    console.log('positions after settle', Array.isArray(pos2) ? pos2.length : pos2, pos2);

    const trades2 = await fetch(`${u}/rest/v1/trades?select=id,user_id,market_id,instrument,side,quantity_mwh,delivery_start,delivery_end,execution_price,price_timestamp,status&user_id=eq.${uid}&order=executed_at.desc&limit=5`, {
      headers: { apikey: k, authorization: `Bearer ${k}` },
    }).then(r => r.json());
    console.log('trades after settle', Array.isArray(trades2) ? trades2.length : trades2, trades2);

    const acct2 = await fetch(`${u}/rest/v1/paper_accounts?select=id,user_id,starting_cash,cash_balance,updated_at&user_id=eq.${uid}`, {
      headers: { apikey: k, authorization: `Bearer ${k}` },
    }).then(r => r.json());
    console.log('paper_accounts after settle', Array.isArray(acct2) ? acct2.length : acct2, acct2);
  }  // 8. trade detail: the fill's execution result
  if (t.status === 200 && t.data) {
    console.log('trade result', JSON.stringify(t.data).slice(0, 800));
  }

  // 21. Confirm the live parameter signature of key rpc functions (called after the
  // real trade so the sig probes see real market/time data, not just error shapes).
  // For any function that error 404s on the first shape, probe a couple alternate
  // argument/name orders and capture whichever shape the live DB accepts.
  //
  // The probe's `fn` values are documented probe labels rather than literal
  // database function names in some cases. TypeScript treats them as string
  // literals, so narrow them to `string` so the `rawRpc(sc.fn, …)` call does
  // not trip against a strict function-name union in the project's typecheck.
  interface SigCase { fn: string; label: string; body: Record<string, unknown>; }
  const sigCases: SigCase[] = [
    { fn: 'settle_delivered_positions', label: 'settle_delivered_positions(user)', body: { p_user_id: uid } },
    { fn: 'sim_now', label: 'sim_now(user)', body: { p_user_id: uid } },
    { fn: 'sim_now', label: 'sim_now(set_new_time)', body: { p_user_id: uid, p_new_time: deliveryEnd } },
    { fn: 'price_at', label: 'price_at(ts,as_of)', body: { p_market_id: mid, p_product: 'DAM_HOURLY', p_ts: deliveryStart, p_as_of: deliveryStart } },
    { fn: 'instrument_price', label: 'instrument_price(market,counter,instr,product,from,to,as_of)', body: { p_market_id: mid, p_counter_market_id: null, p_instrument: 'ENERGY_SPOT', p_product: 'DAM_HOURLY', p_from: deliveryStart, p_to: deliveryEnd, p_as_of: deliveryStart } },
    { fn: 'position_marks', label: 'position_marks(user)', body: { p_user_id: uid } },
    { fn: 'position_value_changes', label: 'position_value_changes(user)', body: { p_user_id: uid } },
    { fn: 'position_value_changes(market,user)', label: 'position_value_changes(market,user)', body: { p_market_id: mid, p_user_id: uid } },
    { fn: 'mark_positions', label: 'mark_positions(user)', body: { p_user_id: uid } },
    { fn: 'mark_positions(market,user)', label: 'mark_positions(market,user)', body: { p_market_id: mid, p_user_id: uid } },
    { fn: 'set_sim_clock', label: 'set_sim_clock(user,iso)', body: { p_user_id: uid, p_iso: deliveryEnd } },
    { fn: 'clear_sim_clock', label: 'clear_sim_clock(user)', body: { p_user_id: uid } },
    { fn: 'price_row_id', label: 'price_row_id(as_of,market,product,delivery_start)', body: { p_as_of: deliveryStart, p_market_id: mid, p_product: 'DAM_HOURLY', p_delivery_start: deliveryStart } },
    { fn: 'price_row_id(p_ts)', label: 'price_row_id(as_of,market,product,ts)', body: { p_as_of: deliveryStart, p_market_id: mid, p_product: 'DAM_HOURLY', p_delivery_start: deliveryStart } },
    { fn: 'price_is_stale', label: 'price_is_stale(as_of,market,product,delivery_start)', body: { p_as_of: deliveryStart, p_market_id: mid, p_product: 'DAM_HOURLY', p_delivery_start: deliveryStart } },
    { fn: 'price_is_stale(p_ts)', label: 'price_is_stale(as_of,market,product,ts)', body: { p_as_of: deliveryStart, p_market_id: mid, p_product: 'DAM_HOURLY', p_delivery_start: deliveryStart } },
    { fn: 'instrument_entry_price', label: 'instrument_entry_price(market,counter,instr,product,from,to,as_of)', body: { p_market_id: mid, p_counter_market_id: null, p_instrument: 'ENERGY_SPOT', p_product: 'DAM_HOURLY', p_from: deliveryStart, p_to: deliveryEnd, p_as_of: deliveryStart } },
    { fn: 'instrument_settlement_price', label: 'instrument_settlement_price(market,instr,product,from,to,as_of)', body: { p_market_id: mid, p_instrument: 'ENERGY_SPOT', p_product: 'DAM_HOURLY', p_from: deliveryStart, p_to: deliveryEnd, p_as_of: deliveryStart } },
    { fn: 'last_settlement_price', label: 'last_settlement_price(as_of,market,product,delivery_start)', body: { p_as_of: deliveryStart, p_market_id: mid, p_product: 'DAM_HOURLY', p_delivery_start: deliveryStart } },
    { fn: 'last_settlement_price(p_ts)', label: 'last_settlement_price(as_of,market,product,ts)', body: { p_as_of: deliveryStart, p_market_id: mid, p_product: 'DAM_HOURLY', p_delivery_start: deliveryStart } },
    { fn: 'update_portfolio_holdings', label: 'update_portfolio_holdings(p_user_id,portfolio_id)', body: { p_user_id: uid, p_portfolio_id: 'redundant' } },
    { fn: 'update_portfolio_holdings2', label: 'update_portfolio_holdings2(p_portfolio_id,user_id)', body: { p_portfolio_id: 'redundant', p_user_id: uid } },
    { fn: 'update_portfolio_holdings(p_portfolio_id,user_id)', label: 'update_portfolio_holdings(p_portfolio_id,user_id)', body: { p_portfolio_id: 'redundant', p_user_id: uid } },
    { fn: 'update_portfolio_holdings(p_user_id_only)', label: 'update_portfolio_holdings(p_user_id_only)', body: { p_user_id: uid } },
    { fn: 'price_latest_in_window', label: 'price_latest_in_window(market,product,from,to,as_of)', body: { p_market_id: mid, p_product: 'DAM_HOURLY', p_from: deliveryStart, p_to: deliveryEnd, p_as_of: deliveryStart } },
    { fn: 'price_average', label: 'price_average(market,product,from,to,as_of)', body: { p_market_id: mid, p_product: 'DAM_HOURLY', p_from: deliveryStart, p_to: deliveryEnd, p_as_of: deliveryStart } },
    { fn: 'close_position', label: 'close_position(user,position)', body: { p_user_id: uid, p_position_id: 'redundant' } },
    { fn: 'return_positions', label: 'return_positions(user)', body: { p_user_id: uid } },
    { fn: 'waterfall_delivery', label: 'waterfall_delivery(user)', body: { p_user_id: uid } },
    { fn: 'return_positions(product,user)', label: 'return_positions(product,user)', body: { p_product: 'DAM_HOURLY', p_user_id: uid } },
    { fn: 'waterfall_delivery(product,user)', label: 'waterfall_delivery(product,user)', body: { p_product: 'DAM_HOURLY', p_user_id: uid } },
    { fn: 'decompose_position', label: 'decompose_position(user,position)', body: { p_user_id: uid, p_position_id: 'redundant' } },
    { fn: 'decompose_position(p_position_id,user_id)', label: 'decompose_position(p_position_id,user_id)', body: { p_position_id: 'redundant', p_user_id: uid } },
  ];
  const sigResults: Array<{ label: string; status: number; payload: unknown }> = [];
  for (const sc of sigCases) {
    const r = await rawRpc(sc.fn, sc.body);
    sigResults.push({ label: sc.label, status: r.status, payload: r.error ?? r.data });
    if (r.status === 404) {
      // Probe alternate param-name order for functions whose 404 hint reveals the
      // expected parameter list. Only apply to functions known to be order-sensitive.
      if (
          sc.fn === 'price_row_id' ||
          sc.fn === 'price_row_id(p_ts)' ||
          sc.fn === 'price_is_stale' ||
          sc.fn === 'price_is_stale(p_ts)' ||
          sc.fn === 'last_settlement_price' ||
          sc.fn === 'last_settlement_price(p_ts)' ||
          sc.fn === 'instrument_settlement_price' ||
          sc.fn === 'price_latest_in_window' ||
          sc.fn === 'price_average' ||
          sc.fn === 'instrument_price' ||
          sc.fn === 'update_portfolio_holdings' ||
          sc.fn === 'update_portfolio_holdings2' ||
          sc.fn === 'update_portfolio_holdings(p_portfolio_id,user_id)' ||
          sc.fn === 'close_position' ||
          sc.fn === 'return_positions' ||
          sc.fn === 'return_positions(product,user)' ||
          sc.fn === 'waterfall_delivery' ||
          sc.fn === 'waterfall_delivery(product,user)' ||
          sc.fn === 'position_value_changes' ||
          sc.fn === 'position_value_changes(market,user)' ||
          sc.fn === 'mark_positions' ||
          sc.fn === 'mark_positions(market,user)' ||
          sc.fn === 'decompose_position' ||
          sc.fn === 'decompose_position(p_position_id,user_id)'
        ) {
          const altBodies: Array<{ label: string; body: Record<string, unknown> }> = [];
          const probeFn = sc.fn;

          if (sc.fn === 'instrument_settlement_price') {
            altBodies.push({ label: 'alt(p_market_id,p_instrument,p_product,p_from,p_to,p_as_of)', body: { p_market_id: mid, p_instrument: 'ENERGY_SPOT', p_product: 'DAM_HOURLY', p_from: deliveryStart, p_to: deliveryEnd, p_as_of: deliveryStart } });
            altBodies.push({ label: 'alt2(p_counter_market_id,p_from,p_instrument,p_market_id,p_product,p_to,p_as_of)', body: { p_counter_market_id: null, p_from: deliveryStart, p_instrument: 'ENERGY_SPOT', p_market_id: mid, p_product: 'DAM_HOURLY', p_to: deliveryEnd, p_as_of: deliveryStart } });
          } else if (sc.fn === 'price_latest_in_window') {
            altBodies.push({ label: 'alt(p_from,p_to,p_market_id,p_product,as_of)', body: { p_from: deliveryStart, p_to: deliveryEnd, p_market_id: mid, p_product: 'DAM_HOURLY', p_as_of: deliveryStart } });
          } else if (sc.fn === 'price_average') {
            altBodies.push({ label: 'alt(p_from,p_to,p_market_id,p_product,as_of)', body: { p_from: deliveryStart, p_to: deliveryEnd, p_market_id: mid, p_product: 'DAM_HOURLY', p_as_of: deliveryStart } });
          } else if (sc.fn === 'instrument_price') {
            altBodies.push({ label: 'alt(p_market_id,p_product,p_from,p_to,p_counter_market_id,p_instrument,as_of)', body: { p_market_id: mid, p_product: 'DAM_HOURLY', p_from: deliveryStart, p_to: deliveryEnd, p_counter_market_id: null, p_instrument: 'ENERGY_SPOT', p_as_of: deliveryStart } });
            altBodies.push({ label: 'alt2(p_from,p_to,p_market_id,p_product,p_counter_market_id,p_instrument,p_as_of)', body: { p_from: deliveryStart, p_to: deliveryEnd, p_market_id: mid, p_product: 'DAM_HOURLY', p_counter_market_id: null, p_instrument: 'ENERGY_SPOT', p_as_of: deliveryStart } });
          }

          if (sc.fn === 'update_portfolio_holdings' || sc.fn === 'update_portfolio_holdings2' || sc.fn === 'update_portfolio_holdings(p_portfolio_id,user_id)') {
            altBodies.push({ label: 'alt(p_portfolio_id,p_user_id)', body: { p_portfolio_id: 'redundant', p_user_id: uid } });
          }
          if (sc.fn === 'close_position') {
            altBodies.push({ label: 'alt(p_position_id,p_user_id)', body: { p_position_id: 'redundant', p_user_id: uid } });
          }
          if (sc.fn === 'price_row_id' || sc.fn === 'price_row_id(p_ts)' || sc.fn === 'price_is_stale' || sc.fn === 'price_is_stale(p_ts)' || sc.fn === 'last_settlement_price' || sc.fn === 'last_settlement_price(p_ts)') {
            altBodies.push({ label: 'alt(p_as_of,p_market_id,p_product,p_ts)', body: { p_as_of: deliveryStart, p_market_id: mid, p_product: 'DAM_HOURLY', p_ts: deliveryStart } });
          }
          if (sc.fn === 'return_positions' || sc.fn === 'waterfall_delivery') {
            altBodies.push({ label: 'alt(p_product,p_user_id)', body: { p_product: 'DAM_HOURLY', p_user_id: uid } });
            altBodies.push({ label: 'alt2(p_user_id,p_product)', body: { p_user_id: uid, p_product: 'DAM_HOURLY' } });
          }
          if (sc.fn === 'position_value_changes' || sc.fn === 'position_value_changes(market,user)') {
            altBodies.push({ label: 'alt(p_market_id,p_user_id)', body: { p_market_id: mid, p_user_id: uid } });
            altBodies.push({ label: 'alt2(p_user_id,p_market_id)', body: { p_user_id: uid, p_market_id: mid } });
          }
          if (sc.fn === 'mark_positions' || sc.fn === 'mark_positions(market,user)') {
            altBodies.push({ label: 'alt(p_market_id,p_user_id)', body: { p_market_id: mid, p_user_id: uid } });
            altBodies.push({ label: 'alt2(p_user_id,p_market_id)', body: { p_user_id: uid, p_market_id: mid } });
          }
          if (sc.fn === 'decompose_position' || sc.fn === 'decompose_position(p_position_id,user_id)') {
            altBodies.push({ label: 'alt(p_position_id,p_user_id)', body: { p_position_id: 'redundant', p_user_id: uid } });
            altBodies.push({ label: 'alt2(p_user_id,p_position_id)', body: { p_user_id: uid, p_position_id: 'redundant' } });
          }
          for (const alt of altBodies) {
            const a = await rawRpc(probeFn, alt.body);
            sigResults.push({ label: `${sc.label} -> ${alt.label}`, status: a.status, payload: a.error ?? a.data });
            if (a.status !== 404) break;
          }
      }
    }
  }

  for (const sr of sigResults) {
    console.log('sig', sr.label, sr.status, JSON.stringify(sr.payload).slice(0, 400));
  }

  console.log('DONE');
}

// --- entry ---
(async () => {
  try {
    await resolveMid();
    const { deliveryStart, deliveryEnd } = await buildDeliveryWindows();
    await main(deliveryStart, deliveryEnd);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();


