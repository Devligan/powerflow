import type { Metadata } from "next";
import { Archivo, IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

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

export const metadata: Metadata = {
  title: "PowerFlow — ERCOT paper trading desk",
  description:
    "Paper-trade ERCOT hub and load-zone power: hourly day-ahead and real-time series, 15-minute intervals, spreads and block forwards, settled by a real matching engine against simulated prices.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${archivo.variable} ${plexSans.variable} ${plexMono.variable} h-full`}
    >
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
