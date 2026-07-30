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

- [ ] Collapsed chips show active-note title, attachment count, Vault state,
      and folder scope without exposing note body.
- [ ] Expanded context disclosure explains each scope and remains usable at
      280px width and 200% zoom.
- [ ] Active Note off: current note/selection is not sent.
- [ ] Active Note on: the current note and selection are available.
- [ ] Vault RAG off: no automatic search snippets; search/list/read/org tools
      still reach non-secret notes without attach.
- [ ] Vault RAG on: bounded note citations appear.
- [ ] Attach/detach current note updates that chat only (prompt context seed).
- [ ] **Mark secret** on the active note's notebook excludes it from search,
      list, read, organization tools, and Vault RAG.
- [ ] Secret count chip reflects marked notebooks globally.
- [ ] **Unmark secret** restores normal tool access for that notebook.
- [ ] Attaching a note in a secret notebook does not bypass the exclusion.

## Note-writing rules

- [ ] A new profile shows the conservative note-writing default under plugin
      settings.
- [ ] A custom prompt is included after the fixed note-writing rules.
- [ ] Instructions embedded inside note content are treated as data, not obeyed.
- [ ] Editing preserves facts, uncertainty, Markdown, links, tasks, and code
      unless the request explicitly requires a change.
- [ ] Material ambiguity produces one focused question instead of a risky edit.
- [ ] The model does not fabricate missing facts, quotes, or citations.

## Keyboard shortcuts

- [ ] `Ctrl+Alt+B` hides the AI sidebar; pressing it again restores the sidebar.
- [ ] With an existing draft, select note text and press `Ctrl+L`: the sidebar
      opens, the selection is appended after one blank line, and the composer
      receives focus.
- [ ] `Ctrl+L` does not submit the draft or call the provider.
- [ ] With no editor selection, `Ctrl+L` opens the sidebar without changing the
      draft.
- [ ] With a selection, press `Ctrl+Shift+L`: a **new** chat is created, the
      sidebar opens, and the selection is pasted into that chat's composer.
- [ ] With no selection, `Ctrl+Shift+L` still opens a new empty chat.
- [ ] Existing `Ctrl+L` behavior is unchanged after adding `Ctrl+Shift+L`.

## Bypass permissions

- [ ] New and pre-feature chats show **Writes review** and require the normal
      review batch.
- [ ] Enabling **Bypass permissions** shows a warning; cancelling keeps review
      mode.
- [ ] Confirming affects only the current chat and persists after restart.
- [ ] Non-delete proposal batches apply without opening review, including a second
      batch proposed during model continuation.
- [ ] Deletion proposals always open ChangeReview and auto-open a Review Note in
      the secret **AI Reviews** notebook despite bypass permissions.
- [ ] Review Note is view-only; Apply/Discard in the sidebar strip resolves the
      batch and deletes the temp note.
- [ ] **Open review** recreates the Review Note if it was deleted manually.
- [ ] Concurrently modified notes/files remain untouched and report conflicts.
- [ ] Supported updates expose **Undo**; created notes are not auto-deleted.
- [ ] Disabling bypass permissions requires no warning and restores review mode.

## Note and notebook organization

Use disposable notebooks and notes.

- [ ] Create a root notebook and a nested notebook through reviewed proposals.
- [ ] Rename a note and notebook; concurrent edits produce conflicts.
- [ ] Move a note between notebooks.
- [ ] Set manual note order, switch Joplin sorting to **Custom**, and confirm
      visible order changes.
- [ ] Delete a note; review states Joplin Trash and the note is recoverable.
- [ ] Delete a notebook containing disposable items; review states contained
      items move to Trash and the notebook is recoverable.
- [ ] No organization tool offers permanent deletion.

## Required folder scenario

Prepare a disposable folder with Markdown containing front matter, code fences,
links, a table, LF/CRLF variants, a BOM file, and a file ignored by
`.gitignore`.

1. Create a chat and select the folder.
2. Ask: `Review these Markdown files and improve clarity while preserving structure.`
3. Confirm scan/progress and per-file diffs appear before any write.
4. Reject one diff and accept the others.
5. Select **Apply** once.
6. Confirm only accepted files changed.
7. Confirm BOM, line endings, final newline, permissions, front matter, fences,
   links, and tables remain valid.
8. Select **Undo** and byte-compare restored originals.

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
- [ ] Empty, 100+, and 1,000-message chats initially render the latest 100;
      **Load 100 earlier** preserves reading position.
- [ ] Scrolling upward during streaming preserves position and shows
      **Jump to latest** with an unread count.
- [ ] Chat switch and local submission move to the latest message.
- [ ] Rapid Enter/click posts one request and persists one user message.
- [ ] Stop interrupts a streaming/bulk run.
- [ ] Live run activity stays collapsed to one summary row by default; expand
      shows the full tool list without taking over the transcript.
- [ ] Clear requires confirmation and preserves the chat/folder context.
- [ ] Delete requires irreversible-action confirmation.
- [ ] Corrupt one disposable chat JSON: it is quarantined and other chats load.

## Cursor-inspired chat UX

- [ ] Composer footer shows last-run token usage (`in · out · total`) after
      completion.
- [ ] Failed runs show **Retry**; latest assistant message shows **Regenerate**.
- [ ] **Ask** mode disables write/propose tools; **Agent** mode keeps current
      review/bypass behavior.
- [ ] Connection status opens an inline model picker when models are available.
- [ ] **Rename chat** in the header menu updates the chat picker title.
- [ ] Assistant turns show a collapsed **Run · status · tokens** timeline when
      a run summary exists.
- [ ] Pending ChangeReview docks below the transcript as a slim control strip;
      diffs appear in the Review Note; composer stays visible but disabled until
      Apply/Discard.

## Assistant output actions

- [ ] **Copy** remains visible; **Sources (N)** and **More actions** work by
      keyboard and close with Escape.
- [ ] **Insert** adds one saved assistant response at the editor cursor.
- [ ] **Replace selection** replaces only the current editor selection.
- [ ] **Append** adds the response to the active note.
- [ ] **Create note** prompts for a title and creates it in the active notebook.

## Sidebar layout and accessibility matrix

Repeat core chat, streaming, Stop, offline error, folder review, Apply, conflict,
Discard, and Undo flows across:

- [ ] Widths 280px, 360px, and 600px; short and tall panels.
- [ ] Below 280px, **Widen panel** replaces unusable controls and keyboard focus
      stays out of the hidden sidebar.
- [ ] Light, dark, and high-contrast themes.
- [ ] 200% zoom with no clipped composer or unreachable review footer.
- [ ] Mouse and keyboard-only operation.
- [ ] Screen-reader smoke test: dedicated run announcements, busy feed, author/
      timestamp/position labels, collapsed Sources, and concise error alerts.
- [ ] Reduced-motion OS setting.

Confirm long responses never render behind the composer. Confirm transcript is
the main scroll region; the Review Note editor and six-line composer overflow
only within their own bounded controls.
