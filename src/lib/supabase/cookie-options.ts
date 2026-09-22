/**
 * Cookie attributes for the Supabase auth/session cookies. The library
 * defaults to httpOnly:false with no Secure flag, which would leave the
 * access/refresh tokens readable by script and allowed over plain HTTP.
 * Production forces Secure; httpOnly keeps tokens out of JavaScript.
 */
export const AUTH_COOKIE_OPTIONS = {
  path: "/",
  sameSite: "lax" as const,
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
};