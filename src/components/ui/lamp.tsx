/**
 * A status lamp.
 *
 * Colour is inherited from its container, so a lamp inside a tag takes that
 * tag's colour and a lamp on its own takes the surrounding text colour. It is
 * `aria-hidden` because the colour is always restated in words next to it —
 * meaning never travels by colour alone.
 */
export function Lamp({
  pulse = false,
  className = "",
}: {
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`lamp ${pulse ? "lamp-pulse" : ""} ${className}`}
    />
  );
}
