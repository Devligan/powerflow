import type { Metadata } from "next";
import { Archivo, IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { getViewerTimeZone } from "@/lib/time-zone-server";
import { TimeZoneProvider } from "@/components/time-zone";

/*
 * Three faces, three jobs. Archivo carries structure, IBM Plex Sans carries
 * prose, and IBM Plex Mono carries every number, code and timestamp — the
 * faceplate caption and the data column both read better monospaced. None of
 * them is a framework default.
 */
const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  display: "swap",
});

const plexSans = IBM_Plex_Sans({
  variable: "--font-plex",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

const DESCRIPTION =
  "Paper-trade ERCOT's day-ahead market: virtual bids and point-to-point obligations at hubs and load zones, settled against actual ERCOT real-time prices.";

export const metadata: Metadata = {
  // Resolves the generated preview image and canonical links to absolute URLs.
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? "https://powerflow-two.vercel.app"),
  title: "PowerFlow — ERCOT paper trading desk",
  description: DESCRIPTION,
  openGraph: {
    type: "website",
    siteName: "PowerFlow",
    title: "PowerFlow — paper-trade the Texas power market",
    description: DESCRIPTION,
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: "PowerFlow — paper-trade the Texas power market",
    description: DESCRIPTION,
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Every time on the site is shown in the viewer's own zone (src/lib/time.ts).
  const { tz, manual } = await getViewerTimeZone();
  return (
    <html
      lang="en"
      className={`${archivo.variable} ${plexSans.variable} ${plexMono.variable} h-full`}
    >
      <body className="flex min-h-full flex-col">
        <TimeZoneProvider tz={tz} manual={manual}>
          {children}
        </TimeZoneProvider>
      </body>
    </html>
  );
}
