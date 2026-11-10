import { ImageResponse } from "next/og";

export const alt = "PowerFlow — paper-trade the Texas power market on actual ERCOT prices";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const INK = "#0b0c0e";
const PANEL = "#121417";
const LINE = "rgba(230, 227, 221, 0.12)";
const FG = "#e6e3dd";
const DIM = "rgba(230, 227, 221, 0.62)";
const ACCENT = "#e2a33d";

/** The link-preview card: the desk's faceplate, at a glance. */
export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: INK,
          padding: "72px 80px",
          color: FG,
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 64,
              height: 64,
              border: `2px solid ${ACCENT}`,
            }}
          >
            <svg width="36" height="36" viewBox="0 0 24 24" fill={ACCENT}>
              <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
            </svg>
          </div>
          <div style={{ fontSize: 40, fontWeight: 700, letterSpacing: -1 }}>PowerFlow</div>
          <div
            style={{
              marginLeft: 8,
              padding: "6px 14px",
              border: `1px solid ${LINE}`,
              color: DIM,
              fontSize: 20,
              letterSpacing: 3,
            }}
          >
            PAPER TRADING
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ fontSize: 76, fontWeight: 700, lineHeight: 1.05, letterSpacing: -2 }}>
            Trade the Texas power curve, hour by hour.
          </div>
          <div style={{ fontSize: 30, color: DIM, lineHeight: 1.35 }}>
            Actual ERCOT day-ahead and real-time prices, refreshed every 15 minutes.
            Virtual bids and point-to-point obligations, settled automatically.
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderTop: `1px solid ${LINE}`,
            paddingTop: 28,
            fontSize: 22,
            color: DIM,
            letterSpacing: 1,
          }}
        >
          <div style={{ display: "flex", gap: 28 }}>
            <span>7 hubs · 8 load zones</span>
            <span style={{ color: ACCENT }}>●</span>
            <span>$100,000 virtual cash</span>
          </div>
          <div style={{ color: FG, background: PANEL, padding: "8px 16px", border: `1px solid ${LINE}` }}>
            powerflow-two.vercel.app
          </div>
        </div>
      </div>
    ),
    size
  );
}
