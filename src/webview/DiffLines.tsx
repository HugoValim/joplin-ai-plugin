import { parseUnifiedDiffLines } from "./diffStats";

interface DiffLinesProps {
  readonly diff: string;
  readonly maxLines: number;
}

/**
 * Renders unified-diff body lines with add/del/ctx styling.
 *
 * @example <DiffLines diff={change.diff} maxLines={200} />
 */
export function DiffLines(props: DiffLinesProps): JSX.Element {
  const tokens = parseUnifiedDiffLines(props.diff);
  const visible = tokens.slice(0, props.maxLines);
  const truncated = tokens.length > props.maxLines;

  if (visible.length === 0) {
    return <p className="diff-empty">No line diff for this change</p>;
  }

  return (
    <pre className="diff-lines" aria-label="Change diff">
      {visible.map((line, index) => (
        <code
          key={`${line.type}-${index}`}
          className={`diff-line diff-${line.type}`}
        >
          {line.text}
          {"\n"}
        </code>
      ))}
      {truncated ? (
        <code className="diff-line diff-trunc">
          … truncated; open review for the full diff
        </code>
      ) : null}
    </pre>
  );
}
