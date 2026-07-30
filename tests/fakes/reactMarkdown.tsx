import type { ReactNode } from "react";

interface MarkdownLinkProps {
  readonly href?: string;
  readonly children?: ReactNode;
}

interface FakeReactMarkdownProps {
  readonly children: ReactNode;
  readonly urlTransform?: (url: string) => string;
  readonly components?: {
    readonly a?: (props: MarkdownLinkProps) => JSX.Element;
  };
}

/**
 * Keeps DOM tests focused on sidebar behavior outside full Markdown parsing.
 * Still renders one `[label](url)` link so link click/contrast paths stay testable.
 *
 * @example <FakeReactMarkdown>See [docs](https://example.test)</FakeReactMarkdown>
 */
export default function FakeReactMarkdown({
  children,
  urlTransform,
  components,
}: FakeReactMarkdownProps): JSX.Element {
  if (typeof children !== "string" || !components?.a) {
    return <>{children}</>;
  }
  const match = /\[([^\]]+)\]\(([^)]+)\)/.exec(children);
  if (!match) return <>{children}</>;
  const rawHref = match[2] ?? "";
  const href = urlTransform ? urlTransform(rawHref) : rawHref;
  const Link = components.a;
  const before = children.slice(0, match.index);
  const after = children.slice(match.index + match[0].length);
  return (
    <>
      {before}
      <Link href={href || undefined}>{match[1]}</Link>
      {after}
    </>
  );
}
