import { initials } from "@/lib/profile";

/**
 * A trader's picture, or their initials on the panel tone when there is none.
 *
 * A plain <img>: pictures come from the avatars bucket or an OAuth provider's
 * CDN, already small, so the image optimiser would only add a hop.
 */
export function Avatar({
  url,
  name,
  size = 28,
  className = "",
}: {
  url: string | null | undefined;
  name: string | null | undefined;
  size?: number;
  className?: string;
}) {
  const box = { width: size, height: size };
  if (url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt=""
        width={size}
        height={size}
        style={box}
        referrerPolicy="no-referrer"
        className={`flex-none rounded-full border border-white/10 object-cover ${className}`}
      />
    );
  }
  return (
    <span
      aria-hidden
      style={{ ...box, fontSize: Math.max(10, Math.round(size * 0.38)) }}
      className={`flex flex-none items-center justify-center rounded-full border border-white/10 bg-white/[0.04] font-medium t-dim ${className}`}
    >
      {initials(name)}
    </span>
  );
}
