import type { MetadataRoute } from "next";

const SITE = process.env.NEXT_PUBLIC_APP_URL ?? "https://powerflow-two.vercel.app";

/**
 * Crawlers may read the public pages. Everything behind sign-in redirects
 * anyway, and the API is never a page.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/learn", "/leaderboard", "/privacy", "/terms"],
      disallow: ["/api/", "/auth/", "/dashboard", "/markets", "/positions", "/orders", "/trades", "/analytics", "/settings", "/welcome"],
    },
    sitemap: `${SITE}/sitemap.xml`,
  };
}
