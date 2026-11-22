import type { NextConfig } from "next";
import { API_CONTENT_SECURITY_POLICY } from "./src/lib/csp";

// A page's Content-Security-Policy carries a per-request script nonce, so the
// proxy sets it (src/lib/csp.ts). API answers get a fixed one here.
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async redirects() {
    // Old paths; bookmarks and links still land somewhere useful.
    return [
      { source: "/portfolio", destination: "/dashboard", permanent: true },
      { source: "/engineering", destination: "/methodology", permanent: true },
    ];
  },
  async headers() {
    // The dev server needs eval and its own websocket; production does not.
    if (process.env.NODE_ENV !== "production") return [];
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
      {
        source: "/api/:path*",
        headers: [{ key: "Content-Security-Policy", value: API_CONTENT_SECURITY_POLICY }],
      },
    ];
  },
};

export default nextConfig;