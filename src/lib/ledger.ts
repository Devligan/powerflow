import type { LedgerCheckResult } from "@/lib/supabase/database.types";

/**
 * The ledger reconciliation (migration 0054), as the public sees it.
 *
 * pg_cron runs `record_ledger_audit()` hourly at :40 and keeps each result in
 * `ledger_audits`, samples included. The samples name accounts, so they never
 * leave the server: the public status carries each check's count only.
 */

/** Every check the audit runs, in its order, with what it proves. */
export const LEDGER_CHECKS = [
  {
    check: "cash_reconciles",
    label: "Cash follows from fills",
    proves: "Every account's cash, less any deficit, equals its starting cash plus the cash every fill moved.",
  },
  {
    check: "positions_match_trades",
    label: "Positions follow from fills",
    proves: "Every position holds exactly the signed sum of the fills with its identity, and no fills are unheld.",
  },
  {
    check: "settlements_trace",
    label: "Settlements trace to trades",
    proves: "Every settled position points at the account's own settlement fill for the same instrument and window.",
  },
  {
    check: "fills_match_orders",
    label: "Bids match their fills",
    proves: "A filled bid names its fill, with the bid's account, side, size, market and window; no other bid names one.",
  },
  {
    check: "fills_audited",
    label: "Fills are audited",
    proves: "Every fill has its entry in the append-only audit log.",
  },
] as const;

/** The audit runs hourly; two missed runs is an outage, as with ingestion. */
export const LEDGER_AUDIT_MAX_AGE_MIN = 150;

export interface LedgerAuditRow {
  checked_at: string;
  ok: boolean;
  checks: LedgerCheckResult[];
  accounts: number;
  trades: number;
  duration_ms: number | string;
}

export interface PublicLedgerStatus {
  checkedAt: string;
  ok: boolean;
  /** Older than LEDGER_AUDIT_MAX_AGE_MIN: the job has stopped running. */
  stale: boolean;
  accounts: number;
  trades: number;
  durationMs: number;
  checks: Array<{ check: string; label: string; proves: string; violations: number | null }>;
}

/**
 * The newest audit with its samples dropped. A check the audit did not report
 * is `violations: null` and makes the result not ok: a check that silently
 * stopped running must not read as passing.
 */
export function publicLedgerStatus(row: LedgerAuditRow, now: Date = new Date()): PublicLedgerStatus {
  const byName = new Map(row.checks.map((c) => [c.check, c.violations]));
  const checks = LEDGER_CHECKS.map((c) => {
    const n = byName.get(c.check);
    return { ...c, violations: typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null };
  });
  const ageMin = (now.getTime() - Date.parse(row.checked_at)) / 60_000;
  return {
    checkedAt: row.checked_at,
    ok: row.ok && checks.every((c) => c.violations === 0),
    stale: !(ageMin <= LEDGER_AUDIT_MAX_AGE_MIN),
    accounts: Number(row.accounts),
    trades: Number(row.trades),
    durationMs: Number(row.duration_ms),
    checks,
  };
}
