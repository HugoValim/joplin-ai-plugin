# Manual Development Mode acceptance

Use a separate Joplin Development Mode profile. Do not test against important
notes or folders.

## Install

1. Run `npm run dist`.
2. In Development Mode, open **Settings → Plugins → Advanced Settings**.
3. Add this repository root to **Development plugins**.
4. Restart Joplin.
5. Confirm **Joplin AI Agent** appears as a desktop sidebar.

## Provider and privacy

- [ ] Configure an OpenAI-compatible endpoint and required model.
- [ ] **GET /models** status becomes online.
- [ ] API key is masked/secure in settings and absent from sidebar messages,
      chat JSON, console output, and errors.
- [ ] Remote HTTP shows the security warning; cancel prevents the request.
- [ ] HTTPS and localhost do not show the remote-HTTP warning.

## Context

- [ ] Active Note off: current note/selection is not sent.
- [ ] Active Note on: the current note and selection are available.
- [ ] Vault RAG off: no automatic search.
- [ ] Vault RAG on: bounded note citations appear.
- [ ] Attach/detach current note updates that chat only.

## Required folder scenario

Prepare a disposable folder with Markdown containing front matter, code fences,
links, a table, LF/CRLF variants, a BOM file, and a file ignored by
`.gitignore`.

1. Create a chat and select the folder.
2. Ask: `Review these Markdown files and improve clarity while preserving structure.`
3. Confirm scan/progress and per-file diffs appear before any write.
4. Reject one diff and accept the others.
5. Select **Apply accepted** once.
6. Confirm only accepted files changed.
7. Confirm BOM, line endings, final newline, permissions, front matter, fences,
   links, and tables remain valid.
8. Select **Undo last applied run** and byte-compare restored originals.

- [ ] Files ignored by `.gitignore` never appear.
- [ ] `.env*`, credentials, keys, certificates, dependencies, VCS, and build
      output never appear.
- [ ] Traversal and absolute paths fail.
- [ ] A symlink outside the root fails.
- [ ] Binary/invalid UTF-8 and files over 256 KiB fail.
- [ ] More than 50 files or 5 MiB fails before review.

## Conflict scenario

1. Generate a two-file proposal.
2. Modify one source file outside Joplin before applying.
3. Apply the batch.

- [ ] Unchanged accepted file applies.
- [ ] Concurrently modified file remains byte-identical to the external edit.
- [ ] Sidebar reports that item as a conflict.
- [ ] Undo restores only safely applied items and does not overwrite later
      changes.

## Persistence and cancellation

- [ ] Restart Joplin: chats, context toggles, references, and folder root return.
- [ ] Stop interrupts a streaming/bulk run.
- [ ] Clear requires confirmation and preserves the chat/folder context.
- [ ] Delete requires irreversible-action confirmation.
- [ ] Corrupt one disposable chat JSON: it is quarantined and other chats load.

## Assistant output actions

- [ ] **Insert** adds one saved assistant response at the editor cursor.
- [ ] **Replace selection** replaces only the current editor selection.
- [ ] **Append** adds the response to the active note.
- [ ] **Create note** prompts for a title and creates it in the active notebook.
