import type { MetadataRoute } from "next";

const SITE = process.env.NEXT_PUBLIC_APP_URL ?? "https://powerflow-two.vercel.app";

/** The pages anyone can read before signing up. */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${SITE}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE}/learn`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${SITE}/methodology`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${SITE}/status`, changeFrequency: "hourly", priority: 0.4 },
    { url: `${SITE}/leaderboard`, changeFrequency: "daily", priority: 0.6 },
    { url: `${SITE}/signup`, changeFrequency: "yearly", priority: 0.5 },
    { url: `${SITE}/privacy`, changeFrequency: "yearly", priority: 0.2 },
    { url: `${SITE}/terms`, changeFrequency: "yearly", priority: 0.2 },
  ];
}
