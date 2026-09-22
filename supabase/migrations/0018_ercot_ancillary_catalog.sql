-- =====================================================================
-- 0018 - Ancillary-service catalog: one RRS, and the priced product set
--
-- 0017 fixed the invented ECRS pair. Reading ERCOT's own price reports to
-- finish that job turned up a second invention, and a third instrument that a
-- desk with no assets is needlessly locked out of.
--
-- ---------------------------------------------------------------------
-- 1. RRS is one product, not three
-- ---------------------------------------------------------------------
-- 0006 catalogued Responsive Reserve Service as three products:
-- `RRSPFR`, `RRSFFR`, `RRSUFR`. ERCOT does not procure or price RRS that way.
-- ERCOT's published ancillary-service price series are exactly five:
--
--   ECRS, NSPIN, REGDN, REGUP, RRS
--
-- (ERCOT's own AS price dataset, and the Ancillary Services dashboard, both
-- list that set.) There is no RRS-PFR / RRS-FFR / RRS-UFR price.
--
-- The three-way split is real, but it is a *requirement allocation inside*
-- RRS, not three products: the 2026 methodology review sets "the minimum level
-- of RRS from Resources providing RRS using Primary Frequency Response" to
-- 1,377 MW, and FFR is a capability a portion of RRS must have. All of it
-- clears at the single RRS price. So the three codes were three names for one
-- series, and a position in "RRSPFR" would have been priced off a series
-- ERCOT never publishes — i.e. never priced at all.
--
-- Fix: one `RRS` product, matching the series that actually exists.
--
-- ---------------------------------------------------------------------
-- 2. `RRSUFR` was also mislabelled
-- ---------------------------------------------------------------------
-- 0017 tried to correct the "Sustained Frequency Response" tier to Under
-- Frequency Response, but aimed the UPDATE at `instruments` when RRSUFR lived
-- in `products` — so it matched zero rows and did nothing. It is moot here:
-- the tier rows go away, and the single RRS row carries the correct name.
--
-- ---------------------------------------------------------------------
-- 3. DRRS is catalogued but not yet priced
-- ---------------------------------------------------------------------
-- DRRS (Dispatchable Reliability Reserve Service) is a real ERCOT product in
-- active design — NPRR1235 develops it, PUCT gave guidance on flexibility in
-- it, and TAC held workshops in January, February and March 2026. It is not
-- live, so it has no published price series yet. It is catalogued so its
-- series has somewhere to land on arrival, and marked non-tradable, which is
-- what a product with no price series is.
--
-- SCOPE. This desk simulates a financial participant with no physical assets,
-- and providing an ancillary service is a resource obligation that needs a
-- qualified asset behind it. So every AS product stays `tradable = false`, and
-- `AS_CAPACITY` stays non-tradable: there is nothing here a no-asset trader
-- can hold. The products remain catalogued so their series can be ingested,
-- charted and valued.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Remove the three RRS tier products, add the one real one
-- ---------------------------------------------------------------------
-- Guarded for the same reason 0017 guarded the ECRS deletion: a priced or
-- traded product is referenced by an FK, and deleting it would either fail
-- cryptically or orphan history. Fail loudly instead.
do $$
declare
  v_refs int;
begin
  select (select count(*) from public.market_prices where product in ('RRSPFR', 'RRSFFR', 'RRSUFR'))
       + (select count(*) from public.trades        where product in ('RRSPFR', 'RRSFFR', 'RRSUFR'))
       + (select count(*) from public.positions     where product in ('RRSPFR', 'RRSFFR', 'RRSUFR'))
    into v_refs;
  if v_refs > 0 then
    raise exception 'RRS tier products are referenced by % rows; refusing to delete', v_refs;
  end if;
  delete from public.products where code in ('RRSPFR', 'RRSFFR', 'RRSUFR');
end $$;

insert into public.products (code, label, kind, venue, interval_minutes, priced_per, tradable)
values ('RRS', 'Responsive Reserve Service', 'ANCILLARY', 'AS', 60, 'MW', false)
on conflict (code) do update
  set label = excluded.label,
      kind = excluded.kind,
      venue = excluded.venue,
      interval_minutes = excluded.interval_minutes,
      priced_per = excluded.priced_per;

-- ---------------------------------------------------------------------
-- 2. The OTC price option is financial, so a no-asset desk can hold it
-- ---------------------------------------------------------------------
-- `PRICE_OPTION` is a cash-settled option on an ERCOT index: no delivery leg,
-- no qualification, no asset. It was the only purely financial instrument
-- left switched off, and there was no reason for it — the AVERAGE machinery
-- it settles with is already exercised by the tradable block forward and
-- index swap.
update public.instruments
   set tradable = true
 where code = 'PRICE_OPTION';
