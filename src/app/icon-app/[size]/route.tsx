import { ImageResponse } from "next/og";

/**
 * The installed app's icons (manifest.ts): the desk's bolt on its ink plate,
 * as apple-icon.tsx draws it, at the two sizes Android asks for. The bolt
 * sits well inside the maskable safe zone (the middle 80%).
 */
const SIZES = new Set([192, 512]);

export async function GET(_req: Request, ctx: { params: Promise<{ size: string }> }) {
  const size = Number((await ctx.params).size);
  if (!SIZES.has(size)) return new Response("Not found", { status: 404 });
  const bolt = Math.round(size * 0.55);
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0b0c0e",
        }}
      >
        <svg width={bolt} height={bolt} viewBox="0 0 24 24" fill="#e2a33d">
          <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
        </svg>
      </div>
    ),
    {
      width: size,
      height: size,
      headers: { "Cache-Control": "public, max-age=31536000, immutable" },
    }
  );
}
