-- =====================================================================
-- 0045 — ERCOT's bid window and bid increment
--
-- ERCOT's Market Submission Validation Rules (NP4-450): a DAM Energy Bid,
-- DAM Energy-Only Offer (the INC and DEC a virtual trader submits) or PTP
-- Obligation bid may be submitted starting fourteen days before the
-- Operating Day it is for, and until 10:00 the day before (dam_gate, 0038).
-- The desk took bids up to 35 days out.
--
-- Quantities: ERCOT's systems take bids in steps of 0.1 MW (NPRR619: "the
-- value of the smallest bid increment that ERCOT's systems currently
-- accept"). The desk took six decimal places.
--
--   1. dam_bid_window_opens(delivery_start): 00:00 Central fourteen days
--      before the delivery's Operating Day.
--   2. place_limit_order refuses a day-ahead bid before it (DAM_NOT_OPEN)
--      and a quantity off the 0.1 MW grid (QUANTITY_INCREMENT), on the
--      account's own clock as ever.
--
-- Orders already resting are left as they are. NP4-450 also sets a 1 MW
-- minimum per bid; a step of the ticket's bid curve is its own order here, so
-- the ticket applies that minimum to each hour's whole bid instead.
-- =====================================================================

create or replace function public.dam_bid_window_opens(p_delivery_start timestamptz)
returns timestamptz
language sql
stable
set search_path = public
as $$
  select ((((p_delivery_start at time zone 'America/Chicago')::date - 14)::timestamp)
          at time zone 'America/Chicago')
$$;

revoke execute on function public.dam_bid_window_opens(timestamptz) from public, anon;
grant execute on function public.dam_bid_window_opens(timestamptz) to authenticated, service_role;

do $$
declare
  r record;
  v_def text;
begin
  for r in
    select * from (values
      (E'     or p_quantity_mwh <> round(p_quantity_mwh, 6) then\n'
       || E'    raise exception ''QUANTITY_INVALID'';\n'
       || E'  end if;\n',
       E'     or p_quantity_mwh <> round(p_quantity_mwh, 6) then\n'
       || E'    raise exception ''QUANTITY_INVALID'';\n'
       || E'  end if;\n'
       || E'  -- 0045: ERCOT takes bid quantities in steps of 0.1 MW.\n'
       || E'  if p_quantity_mwh <> round(p_quantity_mwh, 1) then\n'
       || E'    raise exception ''QUANTITY_INCREMENT'';\n'
       || E'  end if;\n'),
      (E'  if v_product.code like ''DAM%'' and v_as_of >= public.dam_gate(p_delivery_start) then\n'
       || E'    raise exception ''DAM_CLOSED'';\n'
       || E'  end if;\n',
       E'  if v_product.code like ''DAM%'' and v_as_of >= public.dam_gate(p_delivery_start) then\n'
       || E'    raise exception ''DAM_CLOSED'';\n'
       || E'  end if;\n'
       || E'  -- 0045: and open fourteen days before the operating day.\n'
       || E'  if v_product.code like ''DAM%'' and v_as_of < public.dam_bid_window_opens(p_delivery_start) then\n'
       || E'    raise exception ''DAM_NOT_OPEN'';\n'
       || E'  end if;\n')
    ) as t(old_text, new_text)
  loop
    v_def := pg_get_functiondef(
      'public.place_limit_order(uuid,uuid,text,text,uuid,text,numeric,numeric,timestamptz,timestamptz,timestamptz)'::regprocedure);
    if position(r.new_text in v_def) > 0 then
      continue; -- already applied
    end if;
    if position(r.old_text in v_def) = 0 then
      raise exception '0045: expected text not found in place_limit_order: %', left(r.old_text, 80);
    end if;
    execute replace(v_def, r.old_text, r.new_text);
  end loop;
end
$$;
