-- =====================================================================
-- PowerFlow — security boundary: the `anon` grants that `revoke … from public`
-- does not remove
--
-- Supabase's `public` schema carries DEFAULT PRIVILEGES that grant EXECUTE on
-- every function created there *explicitly* to postgres, **anon**,
-- authenticated and service_role. `revoke execute … from public` therefore
-- removes only the implicit PUBLIC grant; the explicit `anon` grant survives,
-- and a `create or replace` (or a drop/recreate, as in 0006, 0008 and 0010)
-- keeps or re-adds it.
--
-- 0012 documented exactly this mechanism and fixed it for
-- `ensure_user_records` and `get_leaderboard`, but the same mistake was left in
-- place on the functions below.
--
-- Found by attacking the deployed project with a bare anon key (no session),
-- then reproduced from the migrations on a clean database:
--
--   position_marks(p_user_id => <someone else's id>)
--     -> 200, returning that user's position ids and mark prices. RLS blocks
--        the `positions` table for the same caller ("[]"), so this is a read of
--        private data through the SECURITY DEFINER surface: its guard is
--        `auth.uid() is not null and auth.uid() <> p_user_id`, which a NULL uid
--        satisfies — and NULL is what an anonymous caller and the service role
--        both look like.
--   execute_trade(…)                  -> reaches the body (raises FORBIDDEN)
--   instrument_price(…)               -> reachable
--   latest_price_timestamps(uuid[])   -> reachable
--   mint_username(text, uuid)         -> reachable
--   price_at / price_as_of / price_average / price_is_stale / price_row_id
--                                     -> reachable
--
-- Individually the non-`position_marks` entries are low impact: the price
-- helpers read data that is public-read anyway and `mint_username` is a pure
-- function. They are revoked with it because the *posture* the README claims —
-- "Function ACLs are revoked from PUBLIC and anon" — is not what the database
-- was enforcing, and a boundary that is only sometimes true is not one.
--
-- Nothing the application uses depends on the anon grant: the browser client is
-- used only for auth (signup + OAuth), and every RPC call site is server-side —
-- the service role, except `execute_trade`, which runs on the signed-in user's
-- authenticated session.
-- =====================================================================

-- Trade execution: authenticated sessions only.
revoke execute on function public.execute_trade(
  uuid, uuid, uuid, text, text, text, numeric, timestamptz, timestamptz, text
) from anon;
grant execute on function public.execute_trade(
  uuid, uuid, uuid, text, text, text, numeric, timestamptz, timestamptz, text
) to authenticated, service_role;

-- Read-side helpers the UI reaches through the service role.
revoke execute on function public.position_marks(uuid) from anon;
grant execute on function public.position_marks(uuid) to authenticated, service_role;

revoke execute on function public.instrument_price(uuid, uuid, text, text, timestamptz, timestamptz) from anon;
grant execute on function public.instrument_price(uuid, uuid, text, text, timestamptz, timestamptz)
  to authenticated, service_role;

revoke execute on function public.latest_price_timestamps(uuid[]) from anon;
grant execute on function public.latest_price_timestamps(uuid[]) to authenticated, service_role;

-- Price resolution, used by the engine and by the mirrored read side.
revoke execute on function public.price_at(uuid, text, timestamptz) from anon;
revoke execute on function public.price_row_id(uuid, text, timestamptz) from anon;
revoke execute on function public.price_as_of(uuid, text, timestamptz) from anon;
revoke execute on function public.price_is_stale(uuid, text, timestamptz) from anon;
revoke execute on function public.price_average(uuid, text, timestamptz, timestamptz) from anon;
grant execute on function public.price_at(uuid, text, timestamptz) to authenticated, service_role;
grant execute on function public.price_row_id(uuid, text, timestamptz) to authenticated, service_role;
grant execute on function public.price_as_of(uuid, text, timestamptz) to authenticated, service_role;
grant execute on function public.price_is_stale(uuid, text, timestamptz) to authenticated, service_role;
grant execute on function public.price_average(uuid, text, timestamptz, timestamptz) to authenticated, service_role;

-- Username minting is called from a SECURITY DEFINER function (owner rights),
-- never from a browser.
revoke execute on function public.mint_username(text, uuid) from anon;
grant execute on function public.mint_username(text, uuid) to authenticated, service_role;
