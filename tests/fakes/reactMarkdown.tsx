import type { ReactNode } from "react";

/**
 * Keeps DOM tests focused on sidebar behavior outside Markdown parsing.
 *
 * @example <FakeReactMarkdown>Text</FakeReactMarkdown>
 */
export default function FakeReactMarkdown({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return <>{children}</>;
}
