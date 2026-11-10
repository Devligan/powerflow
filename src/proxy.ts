import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import {
  isSupabaseConfigured,
  requireSupabaseAnonKey,
  requireSupabaseUrl,
} from "@/lib/supabase/config";
import { AUTH_COOKIE_OPTIONS } from "@/lib/supabase/cookie-options";
import { isCrossSiteWrite } from "@/lib/same-origin";

/**
 * Route protection + Supabase session refresh (cookie rotation).
 * API routes only pass the cross-site check here: each handler performs its
 * own auth, and the cron endpoints are guarded by CRON_SECRET.
 */
export const config = {
  matcher: [
    // Metadata images (link previews, icons) are fetched by crawlers with no
    // session; they must never be redirected to /login.
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|opengraph-image|twitter-image|icon|apple-icon).*)",
  ],
};

// The password pages explain an expired or cross-browser link themselves,
// so they must render for a visitor whose link did not sign them in.
const PUBLIC_PATHS = [
  "/", "/login", "/signup", "/auth", "/privacy", "/terms",
  "/forgot-password", "/reset-password",
  // How the market works, readable before signing up.
  "/learn",
];
// "/auth/" is a prefix, not a path: the OAuth and email-link callback
// (/auth/callback) is reached by a visitor who is not signed in *yet*, and
// sending them to /login would drop the code they arrived with.
// "/challenges/" with the slash: a challenge's own page is shareable — a
// friend sees it, then signs up — while the list of all challenges is not.
const PUBLIC_PREFIXES = ["/leaderboard", "/auth/", "/challenges/"];

export async function proxy(request: NextRequest) {
  const isApi = request.nextUrl.pathname.startsWith("/api/");
  if (
    (isApi || request.nextUrl.pathname === "/auth/signout") &&
    isCrossSiteWrite(request.method, request.headers)
  ) {
    return NextResponse.json({ error: "Cross-site request refused." }, { status: 403 });
  }
  if (isApi) return NextResponse.next();

  let supabaseResponse = NextResponse.next({ request });

  if (!isSupabaseConfigured()) {
    return NextResponse.next({ request });
  }

  const supabase = createServerClient(requireSupabaseUrl(), requireSupabaseAnonKey(), {
    cookieOptions: AUTH_COOKIE_OPTIONS,
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value)
        );
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options)
        );
      },
    },
  });

  // CRITICAL: do not run any code between createServerClient and
  // supabase.auth.getUser() — a missing cookie could trigger a refresh
  // and break cookies in between.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isPublic =
    PUBLIC_PATHS.includes(pathname) ||
    PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  if (user && (pathname === "/" || pathname === "/login" || pathname === "/signup")) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}