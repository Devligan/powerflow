import type { MetadataRoute } from "next";

const SITE = process.env.NEXT_PUBLIC_APP_URL ?? "https://powerflow-two.vercel.app";

/**
 * Crawlers may read the public pages. Everything behind sign-in redirects
 * anyway, and the API is never a page; challenge links are for the friends
 * they are sent to, so they are left out of the sitemap rather than listed.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/learn", "/leaderboard", "/privacy", "/terms"],
      disallow: ["/api/", "/auth/", "/dashboard", "/markets", "/portfolio", "/positions", "/orders", "/trades", "/analytics", "/settings", "/challenges", "/welcome"],
    },
    sitemap: `${SITE}/sitemap.xml`,
  };
}
