import { AUTHOR, SOURCE_REPO } from "@/lib/site";

/** The credit line in the public footers: who built it, and the source. */
export function BuiltBy() {
  return (
    <p className="caption">
      Built by{" "}
      <a href={AUTHOR.github} className="t-fg hover:underline" rel="author">
        {AUTHOR.name}
      </a>{" "}
      ·{" "}
      <a href={SOURCE_REPO} className="hover:underline">
        Source on GitHub
      </a>
    </p>
  );
}
