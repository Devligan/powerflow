-- =====================================================================
-- 0031 — Diagnostic accounts are not traders
--
-- Settlement diagnostics in September created accounts on the shared
-- project (diag-settle-*@test.local) and left them opted into the
-- leaderboard, so they ranked beside real users. Every account on the
-- reserved test.local domain is opted out. Nothing is deleted.
-- =====================================================================

update public.profiles p
set leaderboard_opt_in = false
from auth.users u
where u.id = p.id
  and u.email like '%@test.local'
  and p.leaderboard_opt_in;
