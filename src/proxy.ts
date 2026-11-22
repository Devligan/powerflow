import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import {
  isSupabaseConfigured,
  requireSupabaseAnonKey,
  requireSupabaseUrl,
} from "@/lib/supabase/config";
import { AUTH_COOKIE_OPTIONS } from "@/lib/supabase/cookie-options";
import { isCrossSiteWrite } from "@/lib/same-origin";
import { requiredMediaType } from "@/lib/media-type";
import { fail } from "@/lib/api";
import { contentSecurityPolicy, newNonce } from "@/lib/csp";
import { isPublicPath, sendsSignedInToDesk } from "@/lib/route-access";

/**
 * Route protection + Supabase session refresh (cookie rotation), and each
 * page's Content-Security-Policy with its script nonce.
 * API routes only pass the cross-site and content-type checks here: each
 * handler performs its own auth, and the cron endpoints are guarded by
 * CRON_SECRET.
 */
export const config = {
  matcher: [
    // Metadata files fetched by browsers and crawlers with no session — link
    // previews, icons (/icon.svg, /icon-app/…), the manifest, robots and the
    // sitemap — must never be redirected to /login, and neither may the
    // landing page's screenshots (public/showcase/). "icon" skips every path
    // that starts with it: a page must never be named /icon…
    // (src/lib/route-access.test.ts pins this list).
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|manifest.webmanifest|opengraph-image|twitter-image|icon|apple-icon|showcase/).*)",
  ],
};

export async function proxy(request: NextRequest) {
  const isApi = request.nextUrl.pathname.startsWith("/api/");
  if (
    (isApi || request.nextUrl.pathname === "/auth/signout") &&
    isCrossSiteWrite(request.method, request.headers)
  ) {
    return fail("Cross-site request refused.", 403);
  }
  if (isApi) {
    const required = requiredMediaType(request.method, request.nextUrl.pathname, request.headers);
    if (required) return fail(`Send this request as ${required}.`, 415, { Accept: required });
    return NextResponse.next();
  }

  // This page's script nonce (#72). Next reads it from the policy on the
  // request and puts it on every script it renders; the browser enforces the
  // same policy. Development sends none: its tooling needs eval.
  const csp =
    process.env.NODE_ENV === "production"
      ? contentSecurityPolicy(newNonce(), process.env.NEXT_PUBLIC_SUPABASE_URL)
      : null;
  if (csp) request.headers.set("content-security-policy", csp);
  const withCsp = (res: NextResponse) => {
    if (csp) res.headers.set("Content-Security-Policy", csp);
    return res;
  };

  let supabaseResponse = NextResponse.next({ request });

  if (!isSupabaseConfigured()) {
    return withCsp(NextResponse.next({ request }));
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
    return withCsp(NextResponse.redirect(url));
  }

  if (user && sendsSignedInToDesk(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    return withCsp(NextResponse.redirect(url));
  }

  return withCsp(supabaseResponse);
}