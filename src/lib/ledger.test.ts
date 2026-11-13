import { describe, expect, it } from "vitest";
import { LEDGER_AUDIT_MAX_AGE_MIN, LEDGER_CHECKS, publicLedgerStatus, type LedgerAuditRow } from "./ledger";

const NOW = new Date("2026-11-12T20:00:00Z");

const row = (over: Partial<LedgerAuditRow> = {}): LedgerAuditRow => ({
  checked_at: "2026-11-12T19:40:00Z",
  ok: true,
  checks: LEDGER_CHECKS.map((c) => ({ check: c.check, violations: 0, sample: [] })),
  accounts: 12,
  trades: 340,
  duration_ms: "18.4",
  ...over,
});

describe("publicLedgerStatus", () => {
  it("reports a clean, recent audit as ok", () => {
    const s = publicLedgerStatus(row(), NOW);
    expect(s.ok).toBe(true);
    expect(s.stale).toBe(false);
    expect(s.durationMs).toBe(18.4);
    expect(s.checks.map((c) => c.violations)).toEqual([0, 0, 0, 0, 0]);
  });

  it("never carries the samples, which name accounts", () => {
    const leaked = row({
      ok: false,
      checks: LEDGER_CHECKS.map((c, i) => ({
        check: c.check,
        violations: i === 0 ? 1 : 0,
        sample: i === 0 ? [{ user_id: "secret-user", entity_id: "secret-account", detail: { gap: 1 } }] : [],
      })),
    });
    const s = publicLedgerStatus(leaked, NOW);
    expect(s.ok).toBe(false);
    expect(s.checks[0].violations).toBe(1);
    expect(JSON.stringify(s)).not.toContain("secret");
  });

  it("is not ok when a check is missing or malformed, even if the row says ok", () => {
    const missing = row({ checks: row().checks.slice(1) });
    const s = publicLedgerStatus(missing, NOW);
    expect(s.ok).toBe(false);
    expect(s.checks[0].violations).toBeNull();

    const garbled = row({ checks: row().checks.map((c, i) => (i === 2 ? { ...c, violations: -1 } : c)) });
    expect(publicLedgerStatus(garbled, NOW).ok).toBe(false);
  });

  it("is stale once the hourly job has missed two runs", () => {
    const at = (minutesAgo: number) =>
      publicLedgerStatus(row({ checked_at: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString() }), NOW);
    expect(at(LEDGER_AUDIT_MAX_AGE_MIN).stale).toBe(false);
    expect(at(LEDGER_AUDIT_MAX_AGE_MIN + 1).stale).toBe(true);
    expect(publicLedgerStatus(row({ checked_at: "not a date" }), NOW).stale).toBe(true);
  });
});
