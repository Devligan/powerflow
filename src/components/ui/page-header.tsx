/**
 * A page's faceplate.
 *
 * Left-aligned and ruled off from the content below it, so a page opens with a
 * label and a boundary rather than with a centred title floating in space. The
 * `aside` slot carries live status for the page, which is where a desk puts
 * it.
 */
export function PageHeader({
  kicker,
  title,
  aside,
  children,
}: {
  /** Small caption above the title, e.g. the section or the data source. */
  kicker?: string;
  title: string;
  /** Right-hand slot: status tags, links, an action. */
  aside?: React.ReactNode;
  /** The explanatory line under the title. */
  children?: React.ReactNode;
}) {
  return (
    <header className="reveal border-b border-white/10 pb-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {kicker && <p className="caption">{kicker}</p>}
          <h1
            className={`font-display text-[1.35rem] font-bold tracking-tight ${kicker ? "mt-1.5" : ""}`}
          >
            {title}
          </h1>
        </div>
        {aside && (
          <div className="flex flex-none flex-wrap items-center gap-2">{aside}</div>
        )}
      </div>
      {children && (
        <p className="mt-3 max-w-3xl text-[13px] leading-relaxed t-dim">
          {children}
        </p>
      )}
    </header>
  );
}
