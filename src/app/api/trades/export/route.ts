import { getSessionUser } from "@/lib/auth";
import { getActiveDesk } from "@/lib/desk";
import { LIMITS, overLimit, tooManyRequests } from "@/lib/rate-limit";
import { fail, serverError } from "@/lib/api";
import { format, parseDbDec } from "@/lib/money";
import { getTrades, parseTradeFilters } from "@/lib/queries";
import { MARKET_TIME_ZONE, windowLabel } from "@/lib/time";

export const dynamic = "force-dynamic";

const COLUMNS = [
  "created_at_utc",
  "trade_id",
  "instrument",
  "settlement_point",
  "counter_point",
  "product",
  "venue",
  "side",
  "quantity_mwh",
  "price",
  "notional",
  "delivery_start_utc",
  "delivery_end_utc",
  "delivery_central",
  "status",
  "realized_pnl",
] as const;

/** RFC 4180 field: quoted when it holds a separator, quote or newline. */
function field(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * The blotter as CSV, for reconciliation in a spreadsheet or a risk system.
 * Same filters and the same replayed per-trade P&L as the blotter itself;
 * every money column is an exact decimal string, never a float.
 */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return fail("Unauthorized", 401);
  if (await overLimit(LIMITS.export, user.id)) return tooManyRequests(LIMITS.export);

  const filters = parseTradeFilters(new URL(req.url).searchParams);
  if (!filters) return fail("Invalid filter", 422);

  try {
    const desk = await getActiveDesk(user.id);
    const { rows } = await getTrades(desk.accountUserId, { ...filters, all: true });

    const lines = [COLUMNS.join(",")];
    for (const r of rows) {
      const qty = parseDbDec(r.quantity_mwh);
      const price = parseDbDec(r.execution_price);
      lines.push(
        [
          r.created_at,
          r.id,
          r.instrument,
          r.settlement_point,
          r.counter_settlement_point ?? "",
          r.product,
          r.venue,
          r.side,
          format(qty, 6),
          format(price, 6),
          format((qty * price) / 1_000_000n, 6),
          r.delivery_start,
          r.delivery_end,
          // ERCOT's own clock, matching the column name: a reconciliation
          // file must read the same for every reader, wherever they are.
          windowLabel(Date.parse(r.delivery_start), Date.parse(r.delivery_end), MARKET_TIME_ZONE),
          r.status,
          r.realized_pnl,
        ]
          .map((v) => field(String(v)))
          .join(",")
      );
    }

    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(lines.join("\r\n") + "\r\n", {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="powerflow-blotter-${stamp}.csv"`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    return serverError("trades export", e, "The export could not be created.");
  }
}
