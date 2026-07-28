import type { ChangeSet, ProposedChange } from "../persistence/changeSetStore";

const MAX_DIFF_CHARS = 500_000;

/**
 * Builds the view-only markdown body for a pending Review Note.
 *
 * @example renderReviewDiffDocument({ chatTitle: "Draft", changeSet })
 */
export function renderReviewDiffDocument(input: {
  readonly chatTitle: string;
  readonly changeSet: ChangeSet;
}): string {
  const { chatTitle, changeSet } = input;
  const lines: string[] = [
    "> **View-only review document.** Apply or discard changes in the AI sidebar.",
    "",
    `Chat: **${escapeInline(chatTitle)}**`,
    `Changes: **${changeSet.changes.length}**`,
    "",
    "## Contents",
    "",
  ];

  changeSet.changes.forEach((change, index) => {
    lines.push(
      `${index + 1}. [${escapeInline(changeSummary(change))}](#${anchorFor(change.id)})`,
    );
  });
  lines.push("");

  changeSet.changes.forEach((change) => {
    lines.push(...renderChangeSection(change));
  });

  return lines.join("\n");
}

function renderChangeSection(change: ProposedChange): string[] {
  const lines = [
    `<a id="${anchorFor(change.id)}"></a>`,
    "",
    `## ${escapeInline(change.targetLabel)}`,
    "",
    `- **Kind:** ${change.kind}`,
    `- **Operation:** ${operationLabel(change)}`,
    `- **Status:** ${change.status}`,
  ];
  if (change.message) {
    lines.push(`- **Message:** ${escapeInline(change.message)}`);
  }
  lines.push("");

  if (shouldShowSummaryOnly(change)) {
    lines.push("### Summary", "", `\`${escapeInline(change.before)}\` → \`${escapeInline(change.after)}\``, "");
    return lines;
  }

  lines.push("### Diff", "", "```diff", truncateDiff(change.diff), "```", "");
  return lines;
}

function shouldShowSummaryOnly(change: ProposedChange): boolean {
  if (change.kind === "file") return false;
  if (change.operation === "delete") return true;
  if (change.kind === "notebook" && change.operation !== "create") return true;
  if (
    change.kind === "note" &&
    ["rename", "move", "reorder"].includes(change.operation)
  ) {
    return true;
  }
  return false;
}

function operationLabel(change: ProposedChange): string {
  if (change.kind === "file") return "replace";
  return change.operation;
}

function changeSummary(change: ProposedChange): string {
  return `${operationLabel(change)} · ${change.targetLabel}`;
}

function anchorFor(changeId: string): string {
  return `change-${changeId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function truncateDiff(diff: string): string {
  if (diff.length <= MAX_DIFF_CHARS) return diff;
  return `${diff.slice(0, MAX_DIFF_CHARS)}\n… diff truncated …`;
}

function escapeInline(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\*/g, "\\*");
}
