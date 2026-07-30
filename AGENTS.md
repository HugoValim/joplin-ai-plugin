# Repository Guidelines

Contributor guide for `joplin-plugin-joplin-ai-agent`, a desktop-only Joplin 3.6+
plugin for persistent AI chats, opt-in note retrieval, and controlled note/file
editing.

## Project Structure & Module Organization

```text
src/index.ts        composition entry; wires plugin adapters together
src/plugin/         Joplin adapters, settings, panel, controller
src/agent/          context assembly, bounded agent loop, apply/Undo
src/providers/      endpoint policy, HTTP/SSE transport
src/notes/          data API repository, chunks, retrieval
src/fileWorkspace/  path policy, encoding, hashes, atomic writes
src/tools/          schemas, registry, note/file tools
src/persistence/    chats, change sets, rollback records
src/shared/         errors and versioned panel protocol
src/webview/        React sidebar UI
api/                Joplin plugin API type definitions (read-only)
tests/              public-interface unit and integration tests
docs/               PRIVACY.md, MANUAL_TEST.md
```

One responsibility per module. Keep files under 500 lines and functions to
4–20 lines; split by responsibility when they grow.

## Build, Test, and Development Commands

Requires Node.js 20 and npm.

```bash
npm install          # install dependencies
npm test             # run Jest suite serially (jest --runInBand)
npm run test:watch   # Jest watch mode
npm run typecheck    # tsc --noEmit
npm run lint         # eslint src tests
npm run format:check # prettier --check on src, tests, and root config
npm run dist         # full build: plugin + webview + archive
```

Build outputs:

- Development plugin: `dist/`
- Installable archive: `publish/com.hugovalim.joplin-ai-agent.jpl`

Load the plugin in a separate Joplin Development Mode profile by pointing the
development plugin path at the repo root, then restart Joplin. See
`docs/MANUAL_TEST.md` for manual verification steps.

## Coding Style & Naming Conventions

- TypeScript, strict mode (`tsconfig.json`: `strict`,
  `noUncheckedIndexedAccess`, `noImplicitOverride`).
- ESLint 9 flat config (`eslint.config.mjs`): type-checked rules; `no-explicit-any`
  is an error; `consistent-type-imports` required; unused vars must be prefixed
  `_`.
- Prettier formatting (see `format:check` scope above).
- Explicit return types on declared functions; `allowExpressions` for inline
  arrows. No `any`, no untyped `Dict`.
- Specific, unique names. Avoid `data`, `handler`, `Manager`. Prefer names that
  return fewer than five `grep` hits.
- Early returns over nested ifs; max two indentation levels. Pure, immutable
  data where practical.

## Testing Guidelines

- Framework: Jest 29 with `ts-jest`, Node environment. Webview components use
  `@testing-library/react` and `jest-axe`.
- Tests live in `tests/` mirroring `src/` modules. External I/O is mocked via
  named fakes under `tests/fakes/` (e.g. `joplinApi.ts`, `reactMarkdown.tsx`),
  not inline stubs.
- Run the full suite: `npm test`. Tests must be fast, independent, and
  repeatable; every new function or bug fix gets a test (regression test for
  fixes).
- `api/**`, `dist/**`, `publish/**`, and `node_modules/**` are lint-ignored.

## Commit & Pull Request Guidelines

- Use Conventional Commits, matching the existing history:
  `type(scope): subject`. Seen types: `feat`, `fix`, `docs`, `chore`. Scopes
  mirror `src/` modules: `agent`, `notes`, `fileWorkspace`, `providers`,
  `webview`, `plugin`, `tools`, `chat`, `release`, `test`.
- Keep subjects imperative and lowercase, e.g.
  `feat(notes): open non-secret notes without allowlist`.
- Releases bump the version with `chore(release): bump version to X.Y.Z`.
- PRs should describe the change, link related issues, and note any manual
  verification performed against `docs/MANUAL_TEST.md`. Do not commit secrets
  or API keys; API key storage uses Joplin secure storage only.

## Security & Configuration

- Never hardcode secrets. The API key setting uses Joplin secure storage and
  must never appear in the sidebar, transcripts, provider errors, or logs.
- Endpoints are HTTP(S) only; embedded URL credentials, query/fragment-bearing
  base URLs, redirects, and oversized SSE events are rejected. Remote HTTP
  requires an explicit warning confirmation.
- Retrieved notes/files are treated as untrusted data; fixed system instructions
  forbid acting on their contents as commands.
- External tool paths are root-relative; every operation resolves and validates
  real paths, rejecting traversal, symlink escapes, and device files.
- Note/notebook deletion is recoverable Joplin Trash only; no permanent delete,
  file delete/rename, shell, attachment, or unrestricted filesystem access.
