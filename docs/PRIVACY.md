# Privacy and security disclosure

## Data sent to the configured AI endpoint

For each submitted turn, the plugin sends:

- the user message and retained chat transcript;
- the configured system prompt;
- current note body and editor selection only when **Active note** is enabled;
- explicitly attached notes;
- up to six bounded vault snippets only when **Vault RAG** is enabled;
- tool results requested by the model from Joplin or the selected chat folder.

The selected folder's absolute root is displayed in the sidebar and persisted
locally, but model file tools receive root-relative paths.

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

Model tools never directly write notes or files. They collect proposals for a
single review batch. Applying rechecks every accepted item's `updated_time` or
SHA-256. Conflicting items are not overwritten.

Assistant response buttons are separate explicit user actions. Insert and
replace use Joplin editor commands; append rechecks the active note
`updated_time`; create writes to the active note's notebook.

File originals are retained under the plugin data directory for exact Undo.
Retention is newest ten applied runs and no older than seven days. No rollback
data is stored inside the reviewed folder.

## Endpoint transport

HTTPS and localhost HTTP are accepted. Remote HTTP requires an explicit
security warning confirmation because traffic and credentials could be
intercepted. Redirects and URLs with embedded credentials are rejected.
