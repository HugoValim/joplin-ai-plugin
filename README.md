# Joplin AI Agent

Desktop-only Joplin 3.6+ plugin for persistent AI chats, opt-in note
retrieval, and controlled note/text-file edits.

Plugin ID: `com.hugovalim.joplin-ai-agent`
Version: `0.2.0`

## Features

- Persistent per-chat transcripts, context settings, references, run summaries,
  and one external folder root.
- OpenAI-compatible `/chat/completions` streaming and `GET /models`
  connectivity checks. Works with Ollama and compatible endpoints; no provider
  SDK required.
- Fragment-safe SSE parsing, parallel tool-call assembly, typed usage, timeout,
  cancellation, eight-step model limit, and twenty-tool-call limit.
- Active-note/selection context only when enabled.
- Explicit attached notes and opt-in vault RAG.
- Fixed note-writing rules resist prompt injection, preserve meaning and
  Markdown, prevent fabricated facts/citations, and require conservative
  handling of material ambiguity.
- Keyword Markdown retrieval on Joplin 3.6. Native semantic results are merged
  when `joplin.ai.search()` exists (Joplin 3.7+); failures fall back to keyword
  retrieval.
- Read tools for notes, notebooks, and selected-folder text files.
- Note/file writes are proposals. Review is required by default. A warned,
  per-chat **Auto-apply changes** toggle applies every proposed item without
  showing the review batch.
- Review or automatic-apply results return to the bounded agent loop so the
  model can finish the task or propose a subsequent batch; retrieved
  continuation context stays memory-only.
- Optimistic concurrency via `updated_time` for notes and SHA-256 for files.
  Conflicting items remain untouched while independent items apply.
- Exact file Undo with persisted source bytes. The latest ten runs, no older
  than seven days, are retained.
- Chat-local folder roots restored on reopen.
- Compact fixed-shell sidebar with a smart-follow, 100-message paged transcript,
  Joplin theme variables, keyboard controls, exact endpoint/model status,
  collapsed context and citations, inline run progress, Stop, and confirmed
  overflow actions.
- `Ctrl+Alt+B` toggles the AI sidebar. `Ctrl+L` opens it, appends up to 20,000
  selected editor characters to the unsent composer, and focuses the prompt
  without sending.
- Explicit response actions insert at the editor cursor, replace the current
  selection, append with an optimistic note-version check, or create a note in
  the active notebook.

## Security model

- API key setting uses Joplin secure storage and never enters the sidebar,
  transcript persistence, provider errors, or logs.
- HTTP(S) endpoints only. Embedded URL credentials, query/fragment-bearing base
  URLs, redirects, malformed responses, and oversized SSE events are rejected.
- Remote HTTP requires an explicit warning confirmation. HTTPS and loopback
  HTTP do not.
- Retrieved notes/files are labelled untrusted data. Fixed system instructions
  forbid treating their contents as commands.
- Text copied with `Ctrl+L` remains a local draft until the user sends it.
- Auto-apply is off for new and legacy chats. Enabling it warns that all model
  proposals in that chat will apply without review; optimistic-concurrency
  checks still isolate conflicts.
- External tool paths are root-relative. Every operation resolves the root and
  target real paths, rejects traversal/symlink escapes/device files, and applies
  text/size/encoding limits.
- Folder scans exclude hidden VCS data, dependencies, build output, `.env*`,
  credential/key/certificate names, binaries, and rollback data. Root
  `.gitignore` rules apply.
- No note/file delete, rename, shell, attachment, unrestricted filesystem, or
  mobile support.

Full disclosure: [docs/PRIVACY.md](docs/PRIVACY.md).

## Provider setup

Open Joplin **Settings → Joplin AI Agent**:

1. Set the base URL. Default: `http://localhost:11434/v1`.
2. Enter an API key when the endpoint requires one.
3. Enter the required model name.
4. Optionally tune the custom system prompt, temperature, output tokens, and
   timeout. Custom instructions follow the fixed safety and note-fidelity rules.

New installs receive a conservative note-writing prompt by default. Existing
custom prompts remain unchanged.

For a remote endpoint, use HTTPS. If only remote HTTP is available, the plugin
shows a security warning before the first chat request.

## Folder review flow

1. Create or select a chat.
2. Select **Add folder**.
3. Ask: `Review these Markdown files and improve clarity while preserving structure.`
4. Review proposed per-file diffs.
5. Accept/reject individual files.
6. Select **Apply accepted** once.
7. Select **Undo last applied run** to restore retained originals.

Defaults: `.md`, `.mdx`, `.txt`; UTF-8/UTF-8 BOM; at most 50 files, 256 KiB
per file, and 5 MiB total source.

## Development

Requires Node.js 20 and npm.

```text
npm install
npm test
npm run format:check
npm run lint
npm run typecheck
npm run dist
```

Build outputs:

- Development plugin: `dist/`
- Installable archive: `publish/com.hugovalim.joplin-ai-agent.jpl`

Use a separate Joplin Development Mode profile. Set the repository root as a
development plugin path, restart Joplin, then follow
[docs/MANUAL_TEST.md](docs/MANUAL_TEST.md).

## Architecture

```text
src/index.ts                 composition entry
src/plugin/                  Joplin adapters, settings, panel, controller
src/agent/                   context, bounded loop, apply/Undo
src/providers/               endpoint policy, HTTP/SSE transport
src/notes/                   data API repository, chunks, retrieval
src/fileWorkspace/           path policy, encoding, hashes, atomic writes
src/tools/                   schemas, registry, note/file tools
src/persistence/             chats, change sets, rollback records
src/shared/                  errors and versioned panel protocol
src/webview/                 React sidebar
tests/                       public-interface unit/integration tests
```

Local plugin data:

```text
chats/index.json
chats/<chat-id>.json
rollbacks/index.json
rollbacks/<run-id>.json
```

Retrieved context and streamed partials are not persisted.
