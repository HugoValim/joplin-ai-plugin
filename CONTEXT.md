# Joplin AI Agent — domain context

Desktop Joplin plugin for persistent AI chats, opt-in note retrieval, and
controlled propose-write batches reviewed by the user before anything applies.

## Glossary

### Review Note

**A temporary, view-only Joplin note that shows the unified diff document for one pending Change Set.**

- Aliases: diff doc, review document, temp review note
- Lifecycle: `Created → Opened → Deleted on resolve`
- Notes: edits in the Review Note are ignored; Apply uses the stored Proposed Changes. One Review Note per pending Change Set.

### Change Set

**One bounded batch of Proposed Changes from a single model run awaiting user decision.**

- Aliases: proposal batch, pending changes, review batch
- Lifecycle: `Proposed → Applied | Partial | Discarded`
- Notes: at most one hundred changes; may reference a Review Note while proposed.

### Proposed Change

**A single model-proposed write (note body, organization, or file replacement) stored before apply.**

- Aliases: proposal, change item
- Lifecycle: `Proposed → Applied | Conflict | Skipped`
- Notes: carries `before`, `after`, unified `diff`, and optimistic-concurrency metadata.

### ChangeReview

**The docked sidebar control strip for selecting items and applying or discarding a Change Set.**

- Aliases: approval strip, review panel
- Notes: lists targets and operations; full diffs live in the Review Note, not inline.

### AI Reviews notebook

**A plugin-managed Joplin notebook that holds Review Notes and is auto-marked secret.**

- Aliases: review notebook, system review folder
- Notes: excluded from agent tools and vault RAG; created on first manual review.

## Boundaries

This context covers human review of model-proposed writes inside Joplin. It
stops at direct assistant output actions (insert/replace/append/create note),
which bypass ChangeReview. Integration points:

- **Joplin editor** — Review Note opens in the normal note editor for reading.
- **Joplin Trash** — applied deletions move targets to recoverable trash;
  restore proposals recover soft-deleted notes/notebooks through the same
  review gates (permanent delete remains forbidden).
- **External folder workspace** — file proposals appear in the same Review Note and ChangeReview list.
