import type { MetadataRoute } from "next";

/**
 * Makes the desk installable: "Add to Home Screen" on a phone opens it full
 * screen with its own name and icon, straight onto the desk.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "PowerFlow — ERCOT paper trading",
    short_name: "PowerFlow",
    description: "Paper-trade ERCOT's real day-ahead and real-time power prices with $100,000 of virtual cash.",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    background_color: "#0b0c0e",
    theme_color: "#0b0c0e",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/icon-app/192", sizes: "192x192", type: "image/png" },
      { src: "/icon-app/512", sizes: "512x512", type: "image/png" },
      { src: "/icon-app/512", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
