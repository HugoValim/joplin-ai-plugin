# Repo map

Last updated: 2026-07-27

## Purpose

Desktop-only Joplin plugin providing persistent OpenAI-compatible AI chats,
opt-in note retrieval, and approval-gated note/text-file edits.

## Stack & tooling

- TypeScript, Node/Electron plugin process, React browser webview.
- npm lockfile, Jest, ESLint, Prettier, Webpack.
- Joplin 3.6+ desktop plugin API.

## Repository layout

- `src/index.ts`: composition-only plugin entry.
- `src/plugin/`: Joplin adapters, settings, panel, startup composition.
- `src/agent/`: context construction and bounded agent loop.
- `src/providers/`: OpenAI-compatible transport and SSE parsing.
- `src/notes/`: Joplin note access, chunking, retrieval.
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
provider stream -> validated tools -> change set -> user approval -> repositories
-> persisted result -> panel event.

Saved assistant messages also expose explicit insert/replace/append/create
actions; note mutations use Joplin commands or optimistic repository updates.

## Constraints & environment

- No secrets enter the webview, chat persistence, or logs.
- External file paths are root-relative, realpath checked, text-only, and bounded.
- Writes require optimistic-concurrency tokens and one batch approval.
- No delete, rename, shell, binary edit, attachment, mobile, or unrestricted FS.

## Current navigation snapshot

- Goal: redesign the desktop sidebar for bounded scrolling, clear hierarchy,
  accessible controls, responsive layouts, efficient long transcripts, and
  trusted model/active-note transparency.
- Entry points: `src/webview/App.tsx`, `src/webview/Transcript.tsx`,
  `src/webview/ChangeReview.tsx`, `src/webview/useSidebarController.ts`,
  `src/plugin/chatController.ts`, and `src/shared/protocol.ts`.
- Data flow: validated plugin events -> `App` state -> header/context/transcript/
  review/composer components -> typed panel requests; provider connection ->
  trusted provider/config session -> model-aware context.
- Decision points: near-bottom auto-scroll, loaded message window, busy/approval
  modes, exclusive per-chat run start, compact-width layout, context disclosure,
  and action availability.
- Side effects: webview messages, scroll/focus movement, confirmation prompts;
  note/file safety and approval semantics remain unchanged.
- Chosen edit point: 97-line composition-only `App`, focused webview components,
  pure scroll policy, protocol v2, and exclusive controller run registration.
- Validation plan: 32-suite Jest gate with DOM/axe/scroll/request-integrity
  coverage; format/lint/typecheck/dist; then light/dark and narrow/wide manual
  Joplin matrix.

## Open questions

- Manual Development Mode checklist requires user-controlled Joplin profile and
  endpoint credentials: `docs/MANUAL_TEST.md`.
