# How ERCOT power trading works, and how PowerFlow models it

A design reference: what a trader in the Texas power market actually does, where
PowerFlow matched it, where it did not, and what remains. Facts are from ERCOT,
ICE and industry sources listed at the end; anything not confirmed there is
marked as such.

## 1. The market a trader faces

**Two energy markets, one physical system.** ERCOT runs a day-ahead market
(DAM) and a real-time market (RTM). Prices are locational: settlement point
prices (SPPs) at resource nodes, load zones (`LZ_*`) and hubs (`HB_*`, e.g.
North, Houston, South, West, Panhandle, Hub Average).

- **Day-ahead**: bids and offers for each hour of an operating day are accepted
  until **10:00 Central on the day before**; ERCOT clears the market and posts
  prices in the early afternoon. The DAM is voluntary and financially binding.
  Nobody knows the clearing price when bidding closes.
- **Real-time**: prices are set every 5 minutes by security-constrained
  economic dispatch and settled on 15-minute SPPs (hourly averages for hourly
  products). Since **5 December 2025** ERCOT runs real-time co-optimization
  with batteries (RTC+B): energy and ancillary services are co-optimized in
  real time.
- **Price bounds**: offers and bids range from **-$250/MWh** to the
  system-wide offer cap of **$5,000/MWh** (a $2,000 low cap applies in some
  conditions). The -$250 floor dates from the 2007 protocol language; confirm
  against the current Nodal Protocols §4.4.9 before relying on it elsewhere.
- **Negative prices are ordinary**: wind (helped by the production tax
  credit) and solar in the West and Panhandle often exceed export capacity.
  In PowerFlow's own ERCOT data for the 60 days to Nov 2026, real-time prices
  were negative in 4–5% of hours at LZ_WEST / HB_WEST and 3–4% at HB_PAN /
  HB_NORTH (lows near -$24); day-ahead in about 3% of hours at the western
  points.

**Who trades.** QSEs (qualified scheduling entities) submit to ERCOT on behalf
of generators, retailers and pure financial traders. A financial trader with
no generation or load trades:

| Instrument | What it is | Settles |
|---|---|---|
| **Virtual DEC** (DAM energy bid) | Buy energy day-ahead at a point | Sold back at the real-time price: earns (RT − DA) × MW |
| **Virtual INC** (DAM energy-only offer) | Sell energy day-ahead | Bought back in real time: earns (DA − RT) × MW |
| **DA PTP obligation** | Buy congestion from source to sink day-ahead | Pays the DA spread, earns the RT spread |
| **CRR** (obligation/option) | Congestion right bought in ERCOT's monthly/annual CRR auctions | Paid the DA congestion spread |
| **Futures / OTC forwards** | ICE ERCOT North 345kV contracts etc.: monthly peak (HE7–22), off-peak, 7x16, daily | Cash-settled against the average of real-time SPPs |

PTP *options* in the DAM are available to NOIEs (municipal and co-op
utilities), not to an ordinary QSE.

**Standard shapes.** Power is quoted in MW for a block of hours: 5x16 peak
(Mon–Fri HE7–22), 2x16 (weekend/NERC-holiday HE7–22), 7x8 off-peak
(HE1–6, HE23–24 every day), 7x24 around the clock, "wrap" (off-peak plus
weekend peak). NERC holidays (New Year's, Memorial Day, Independence Day,
Labor Day, Thanksgiving, Christmas) trade as weekend days. ICE's ERCOT North
real-time peak future is 1 MW for HE0700–2200 CPT.

**Credit.** ERCOT does not debit the notional of a virtual. It holds collateral
against *potential exposure*: for a DAM bid, roughly
`max(0, min(bid price, a percentile price) + e1 × max(0, bid − percentile)) × MW`,
with "e" factors re-estimated at least every two weeks and offsetting bids and
offers netted. Available credit = total credit limit − total potential exposure.

## 2. How a trader works (a DART desk)

1. **Before 10:00 Central**: read load, wind and solar forecasts, outages and
   weather; look at recent DA vs RT by hour and location (DART spreads),
   congestion patterns; decide where real time will clear above or below
   day-ahead.
2. **Submit hourly bids/offers** (often curves) per settlement point, with
   prices that cap what they will pay or floor what they will accept, and
   PTP obligations on paths they expect to congest more in real time.
3. **After the DAM posts**: see what cleared; hedge or adjust.
4. **Through the operating day**: watch real-time prices, ORDC/AS conditions,
   outages; positions settle hour by hour against real time.
5. **End of day**: P&L by hour, point and strategy; risk and collateral.

## 3. PowerFlow against that picture

| Area | Before | Now |
|---|---|---|
| Day-ahead timing | Buy or sell a DA hour at its *already published* price, up to delivery | Bids only before 10:00 Central the day before; fill at the clearing price when published (0038) |
| Trading into a live hour | Accepted until the hour **ended**, with RT prints visible | Closed when delivery **starts** (0037) |
| Negative prices | Limits had to be > $0; amounts printed "$-5" | Limits from -$250 to $5,000; "−$5.00" everywhere (0039) |
| Instruments | 11, of which 8 entered and settled on the same DA price (always $0 P&L) and PTP options bought optionality for $0 | Desk offers virtual INC/DEC and DA PTP obligations, the instruments a QSE without assets bids; PTP options retired |
| Vocabulary | Buy/Sell, MWh | DEC/INC, MW per hour, hour ending, operating day |
| Shapes | Consecutive-hour strips | Hour sheet with 5x16 / 2x16 / 7x8 / 7x24 presets, NERC-holiday aware |
| Time | UTC | Viewer's zone; ERCOT HE and operating days on Central |

## 4. Since then

- **Collateral (0040)**: a bid holds MW × the 95th-percentile |RT − DA| at its
  point over 30 days (≥ $10/MW), and open bids must fit within cash — ERCOT's
  exposure logic in simple form. Still open: fills move cash by notional
  rather than posting collateral, and the $500k gross cap remains.
- **Fundamentals**: the market page shows tomorrow's hourly load, wind and
  solar forecasts, net load and reserve, and the week's peak load, from ERCOT's
  public dashboard feeds (src/lib/fundamentals.ts).
- **Bid curves**: a limit bid is up to four MW-at-price steps per hour, each
  its own order — the same fills as a step curve.
- **Desk analytics**: P&L per settled MWh, DEC vs INC, by hour ending, daily
  Sharpe.
- **Not done**: futures/forwards (no public forward curve) and CRRs (needs
  ERCOT auction prices). Both need a data source before they can be honest.

## Sources

- [ERCOT Day-Ahead Market](https://www.ercot.com/mktinfo/dam/index.html) and
  [Nodal Protocols §4 (Day-Ahead Operations)](https://www.ercot.com/files/docs/2024/06/28/04-071026_Nodal.docx)
- [ERCOT Day-Ahead Market Operations training, 2026](https://www.ercot.com/files/docs/2025/08/22/2026_04-Day-Ahead-Market-Operations.pdf) — $5,000 cap, $2,000 low cap
- [NPRR: energy offer curve range -$250 to the system-wide offer cap (2007)](https://www.ercot.com/files/docs/2007/03/19/12_nprr_xxx_scarcity_pricing_mechanism.doc)
- [ERCOT goes live with RTC+B, 5 Dec 2025](https://www.ercot.com/news/release/12052025-ercot-goes-live)
- [ICE ERCOT North 345KV Real-Time Peak Fixed Price Future](https://www.ice.com/products/6590337/ERCOT-North-345KV-Real-Time-Peak-Fixed-Price-Future)
- [ERCOT DAM collateral parameters / e-factors](https://www.ercot.com/files/docs/2014/06/16/item_9_ercot_cwg_dam_collateral_6_18_14_.pdf), [credit monitoring overview](https://www.ercot.com/files/docs/2010/02/15/cmm_overview.pdf)
- [Yes Energy: how power trading works](https://www.yesenergy.com/blog/how-power-trading-works), [virtual and PTP submission](https://www.yesenergy.com/blog/ercot-virtual-and-point-to-point-trade-submission-challenges)
- [Modo Energy: ERCOT DART explainer](https://modoenergy.com/research/ercot-dart-optimization-explainer-day-ahead-real-time-trading-dart-spread-settlement-energy-arbitrage-battery-energy-storage)
- [EIA: negative prices in ERCOT's West](https://www.eia.gov/todayinenergy/detail.php?id=16831), [Yes Energy: historical ERCOT pricing](https://www.yesenergy.com/blog/historical-ercot-pricing-and-drivers-an-analysis)
- [ERCOT solar report NP4-737-CD notice](https://ercot.com/services/comm/mkt_notices/M-D070122-01), [wind by region NP4-742-CD](https://www.ercot.com/mp/data-products/data-product-details?id=NP4-742-CD)
