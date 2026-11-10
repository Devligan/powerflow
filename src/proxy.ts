import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import {
  isSupabaseConfigured,
  requireSupabaseAnonKey,
  requireSupabaseUrl,
} from "@/lib/supabase/config";
import { AUTH_COOKIE_OPTIONS } from "@/lib/supabase/cookie-options";
import { isCrossSiteWrite } from "@/lib/same-origin";
import { isPublicPath, sendsSignedInToDesk } from "@/lib/route-access";

/**
 * Route protection + Supabase session refresh (cookie rotation).
 * API routes only pass the cross-site check here: each handler performs its
 * own auth, and the cron endpoints are guarded by CRON_SECRET.
 */
export const config = {
  matcher: [
    // Metadata files fetched by browsers and crawlers with no session — link
    // previews, icons (/icon.svg, /icon-app/…), the manifest, robots and the
    // sitemap — must never be redirected to /login. "icon" skips every path
    // that starts with it: a page must never be named /icon…
    // (src/lib/route-access.test.ts pins this list).
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|manifest.webmanifest|opengraph-image|twitter-image|icon|apple-icon).*)",
  ],
};

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

  if (!user && !isPublicPath(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  if (user && sendsSignedInToDesk(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}