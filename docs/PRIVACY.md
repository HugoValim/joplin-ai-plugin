# Privacy and security disclosure

## Data sent to the configured AI endpoint

For each submitted turn, the plugin sends:

- the user message and retained chat transcript;
- editor text explicitly copied into that message with `Ctrl+L`;
- fixed safety and note-writing rules;
- the configured system prompt;
- current note body and editor selection only when **Active note** is enabled;
- explicitly attached notes;
- up to six bounded vault snippets only when **Vault RAG** is enabled;
- tool results requested by the model from Joplin or the selected chat folder.

When **Vault RAG** is off, non-secret notebooks and notes remain reachable via
search, list, read, and organization tools. Vault RAG only adds automatic
bounded snippets to the prompt. Notebooks marked **Secret** in the sidebar are
excluded globally from agent tools and Vault RAG; attaching a note does not
bypass a secret notebook. Active and attached notes still seed prompt context
when those toggles are enabled.

The selected folder's absolute root is displayed in the sidebar and persisted
locally, but model file tools receive root-relative paths.

`Ctrl+L` copies at most 20,000 selected editor characters into the local,
unsent composer. It does not call the configured endpoint until the user
submits the draft.

## Data never sent to the sidebar or chat files

- Provider API keys and Authorization headers.
- Full retrieved-context caches.
- Streamed partials.
- Model reasoning.
- Raw provider request/response bodies.

## External folder access

Folder access is per chat and starts disabled. Eligible source files:

- `.md`, `.mdx`, `.txt`;
- UTF-8 or UTF-8 BOM;
- regular files no larger than 256 KiB.

Bulk limits are 50 files and 5 MiB. The plugin rejects absolute tool paths,
backslashes, dot segments, root escapes, symlink escapes, binary/invalid UTF-8,
mixed line endings, devices, and sensitive/excluded names. It preserves BOM,
LF/CRLF, final-newline presence, and permission mode.

## Writes

Model tools never directly write notes, notebooks, or files. They collect
proposals for a single batch. Review is required by default. A persisted
per-chat **Bypass permissions** toggle can apply non-delete proposals without
displaying the review batch after an explicit warning. Manual review opens a
view-only Review Note in a secret **AI Reviews** notebook (excluded from agent
tools and vault RAG) and deletes it after Apply/Discard. Deletion proposals still
require manual review. Note and notebook deletions use
recoverable Joplin Trash, never permanent deletion. Applying in either mode
rechecks every item's `updated_time` or SHA-256. Conflicting items are not
overwritten.

Assistant response buttons are separate explicit user actions. Insert and
replace use Joplin editor commands; append rechecks the active note
`updated_time`; create writes to the active note's notebook.

File originals are retained under the plugin data directory for exact Undo.
Retention is newest ten applied runs and no older than seven days. No rollback
data is stored inside the reviewed folder. Undo remains available for supported
note-body updates and file writes. Notebook creation and metadata organization
are not included in plugin Undo; trashed items can be recovered through Joplin
Trash.

Fixed instructions tell the model to treat note/file contents as untrusted data,
preserve meaning and Markdown, avoid fabricated facts or citations, and keep
custom instructions subordinate to those rules. These instructions reduce risk
but do not replace hard tool gates or human review; model output is not
inherently trustworthy.

## Endpoint transport

HTTPS and localhost HTTP are accepted. Remote HTTP requires an explicit
security warning confirmation because traffic and credentials could be
intercepted. Redirects and URLs with embedded credentials are rejected.
