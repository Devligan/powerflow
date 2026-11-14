/**
 * The desk's vocabulary in plain words, for people who have never traded
 * power. One source for the tooltips (components/term.tsx) and /learn.
 */
export interface GlossaryEntry {
  term: string;
  short: string;
  detail?: string;
}

export const GLOSSARY = {
  ercot: {
    term: "ERCOT",
    short: "The grid operator for most of Texas. It runs the wholesale power market whose real prices this desk trades.",
  },
  dam: {
    term: "Day-ahead market (DA)",
    short: "An auction held the day before: bids close at 10:00 Central, and ERCOT publishes a clearing price for every hour of the next day in the early afternoon.",
  },
  rt: {
    term: "Real-time market (RT)",
    short: "The price of power as it is actually delivered, set every 15 minutes. It often differs from the day-ahead price — that gap is what you trade.",
  },
  dart: {
    term: "DART spread",
    short: "The gap between the day-ahead and real-time prices for the same hour and place. This desk shows it as real time minus day-ahead (RT − DA): positive when real time came in above day-ahead and a DEC earned, negative when it came in below and an INC earned. Some desks quote it the other way round.",
  },
  virtual: {
    term: "Virtual bid (INC / DEC)",
    short: "A purely financial bet on the DART spread: no power changes hands. A DEC buys day-ahead and sells back in real time, earning (RT − DA) × MW; an INC is the reverse, earning (DA − RT) × MW.",
    detail: "Buy a DEC when you expect real time to price above day-ahead (a hot afternoon, a plant trip); sell an INC when you expect it below (wind that the day-ahead market under-forecast).",
  },
  ptp: {
    term: "PTP obligation",
    short: "A bet on congestion between two places: bought at the day-ahead price difference from a source point to a sink point, paid the real-time difference.",
  },
  settlementPoint: {
    term: "Settlement point (hub, load zone)",
    short: "A place on the grid with its own price. Hubs average many nodes (HB_NORTH, HB_WEST…); load zones are where utilities buy power (LZ_HOUSTON…).",
  },
  hourEnding: {
    term: "Hour ending (HE)",
    short: "How ERCOT names hours: HE18 is the hour that ends at 18:00, i.e. 17:00–18:00 Central.",
  },
  operatingDay: {
    term: "Operating day",
    short: "The Central-time calendar day the power is delivered on. Its bids close at 10:00 Central the day before.",
  },
  clearing: {
    term: "Clearing price",
    short: "The single day-ahead price ERCOT's auction settles at for an hour and place. Every filled bid gets exactly that price.",
  },
  limit: {
    term: "Market vs limit bid",
    short: "A market bid fills at whatever the hour clears at. A limit bid fills only if the clearing price is at or below your limit (buying) or at or above it (selling).",
  },
  mark: {
    term: "Mark",
    short: "What an open position is worth right now, valued on the latest real-time prices published so far.",
  },
  settlement: {
    term: "Settlement",
    short: "When a delivered position is cashed out, at the real-time price once ERCOT calls it final — 16:00 Central, two business days later.",
  },
  collateral: {
    term: "Collateral",
    short: "Cash held aside while a bid or position is open, sized on how far real time has strayed from day-ahead at that point recently. It limits how much one account can bet.",
  },
} as const satisfies Record<string, GlossaryEntry>;

export type GlossaryKey = keyof typeof GLOSSARY;
