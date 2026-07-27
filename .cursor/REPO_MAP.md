# Repo map

Last updated: 2026-07-27

## Purpose

Desktop-only Joplin plugin providing persistent OpenAI-compatible AI chats,
opt-in note retrieval, and policy-gated note/text-file edits.

## Stack & tooling

- TypeScript, Node/Electron plugin process, React browser webview.
- npm lockfile, Jest, ESLint, Prettier, Webpack.
- Joplin 3.6+ desktop plugin API.

## Repository layout

- `src/index.ts`: composition-only plugin entry.
- `src/plugin/`: Joplin adapters, settings, panel, startup composition.
- `src/agent/`: context construction and bounded agent loop.
- `src/providers/`: OpenAI-compatible transport and SSE parsing.
- `src/notes/`: Joplin note/notebook access, organization, chunking, retrieval.
- `src/fileWorkspace/`: root-confined text-file access and rollback.
- `src/tools/`: validated tools and proposed-write routing.
- `src/persistence/`: atomic local chat/change/rollback records.
- `src/shared/`: protocol, schemas, errors, shared types.
- `src/webview/`: React sidebar.
- `tests/`: public-interface unit and integration tests.

## How to run / test / build

- `npm test`
- `npm run lint`
- `npm run typecheck`
- `npm run dist`
- Last verified test invocation: `.cursor/TEST_RUN.md`

## Entry points

- Plugin: `src/index.ts`
- Browser panel: `src/webview/index.tsx`

## Data flow (high level)

Panel message -> validated protocol -> chat/run service -> context snapshot ->
provider stream -> validated tools -> change set -> review or automatic apply
-> repositories -> persisted result -> panel event.

Saved assistant messages also expose explicit insert/replace/append/create
actions; note mutations use Joplin commands or optimistic repository updates.

## Constraints & environment

- No secrets enter the webview, chat persistence, or logs.
- External file paths are root-relative, realpath checked, text-only, and bounded.
- Writes require optimistic-concurrency tokens and either batch review or an
  explicitly warned per-chat auto-apply setting.
- Note/notebook deletion uses Joplin Trash and always requires manual review.
- No permanent deletion, file delete/rename, shell, binary edit, attachment,
  mobile, or unrestricted FS.

## Current navigation snapshot

- Goal: let the agent organize Joplin notes and notebooks safely.
- Entry points: organization tools in `src/tools/`; proposal schemas in
  `src/persistence/changeSetStore.ts`; application through
  `src/agent/noteOrganizationChangeApplier.ts`.
- Data flow: validated tool input -> versioned proposal -> manual/auto review
  policy -> optimistic preflight -> Joplin Data API -> model continuation.
- Decision points: deletion always forces review; deletion is Trash-only;
  metadata writes require current `updated_time`; note order affects Custom
  sorting.
- Side effects: create/rename notebooks; rename/move/reorder notes; trash notes
  or notebooks and their contained items.
- Chosen edit point: a separate organization repository/tool/applier path,
  reusing existing change-set review and conflict isolation.
- Validation plan: public repository/tool/applier/protocol tests, then
  format/lint/typecheck/full Jest/dist gates.

## Open questions

- Manual Development Mode checklist requires user-controlled Joplin profile and
  endpoint credentials: `docs/MANUAL_TEST.md`.
