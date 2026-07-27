import { createHash } from "crypto";
import path from "path";
import { DomainError, safeValue } from "../shared/errors";

export interface FileMetadata {
  readonly size: number;
  readonly mode: number;
  readonly isFile: boolean;
}

export interface FileSystemPort {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<FileMetadata>;
  readFile(path: string): Promise<Buffer>;
}

export interface FileCandidateFinder {
  find(
    absoluteRoot: string,
    patterns: readonly string[],
  ): Promise<readonly string[]>;
}

export interface AtomicWritePort {
  write(absolutePath: string, bytes: Buffer, mode: number): Promise<void>;
}

export interface TextFileSnapshot {
  readonly relativePath: string;
  readonly content: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly hasBom: boolean;
  readonly lineEnding: "LF" | "CRLF";
  readonly hasFinalNewline: boolean;
  readonly mode: number;
}

export interface FileRollbackSnapshot {
  readonly relativePath: string;
  readonly bytesBase64: string;
  readonly sha256: string;
  readonly mode: number;
}

export interface TextSearchMatch {
  readonly relativePath: string;
  readonly line: number;
  readonly preview: string;
}

const DEFAULT_PATTERNS = ["**/*.md", "**/*.mdx", "**/*.txt"];
const MAX_FILES = 50;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const MAX_READ_CONCURRENCY = 4;
const TEXT_EXTENSIONS = new Set([".md", ".mdx", ".txt"]);
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".joplin-ai-agent-rollbacks",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  "target",
  ".next",
  ".venv",
]);
const SENSITIVE_NAME =
  /(?:^|[-_.])(api[-_]?key|certificate|certificates|credential|credentials|password|private[-_]?key|secret|secrets|token|id_rsa|id_ed25519)(?:[-_.]|$)/i;
const SENSITIVE_EXTENSION = new Set([
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".crt",
  ".cer",
]);

export class FileWorkspaceRepository {
  public constructor(
    private readonly root: string,
    private readonly fileSystem: FileSystemPort,
    private readonly finder: FileCandidateFinder,
    private readonly atomicWriter: AtomicWritePort,
  ) {}

  /**
   * Reads one bounded UTF-8 text file after resolving it inside the selected root.
   *
   * @example await repository.readTextFile('docs/guide.md')
   */
  public async readTextFile(relativePath: string): Promise<TextFileSnapshot> {
    validateRelativePath(relativePath);
    validateEligiblePath(relativePath);
    const target = await this.resolveTarget(relativePath);
    const metadata = await this.fileSystem.stat(target);
    validateMetadata(relativePath, metadata);
    const bytes = await this.fileSystem.readFile(target);
    return decodeSnapshot(relativePath, bytes, metadata.mode);
  }

  /**
   * Lists eligible files and returns their concurrency/encoding metadata.
   *
   * @example await repository.listTextFiles()
   */
  public async listTextFiles(): Promise<readonly TextFileSnapshot[]> {
    const root = await this.resolveRoot();
    const candidates = await this.finder.find(root, DEFAULT_PATTERNS);
    const eligible = candidates.filter(isEligiblePath).sort();
    if (eligible.length > MAX_FILES) {
      throw new DomainError(
        "LIMIT_EXCEEDED",
        `Workspace scan found ${eligible.length} files; expected at most ${MAX_FILES}`,
      );
    }
    return this.readBoundedFiles(eligible);
  }

  /**
   * Searches eligible text files without sending binary or ignored data.
   *
   * @example await repository.searchTextFiles('deployment')
   */
  public async searchTextFiles(
    query: string,
  ): Promise<readonly TextSearchMatch[]> {
    if (!query.trim()) {
      throw new DomainError(
        "VALIDATION",
        `Invalid search query ${safeValue(query)}; expected non-empty text`,
      );
    }
    const files = await this.listTextFiles();
    return files.flatMap((file) => findMatches(file, query)).slice(0, 200);
  }

  /**
   * Atomically replaces a file only when its SHA-256 still matches the proposal.
   *
   * @example await repository.writeTextFile('guide.md', next, expectedSha256)
   */
  public async writeTextFile(
    relativePath: string,
    replacement: string,
    expectedSha256: string,
  ): Promise<TextFileSnapshot> {
    const current = await this.readTextFile(relativePath);
    if (current.sha256 !== expectedSha256) {
      throw new DomainError(
        "CONFLICT",
        `File ${relativePath} has SHA-256 ${current.sha256}; expected SHA-256 ${expectedSha256}`,
      );
    }
    const target = await this.resolveTarget(relativePath);
    const bytes = encodeReplacement(replacement, current);
    await this.atomicWriter.write(target, bytes, current.mode);
    return this.readTextFile(relativePath);
  }

  /**
   * Captures exact source bytes for a later approval-run undo.
   *
   * @example await repository.captureRollback('guide.md')
   */
  public async captureRollback(
    relativePath: string,
  ): Promise<FileRollbackSnapshot> {
    const current = await this.readTextFile(relativePath);
    const target = await this.resolveTarget(relativePath);
    const bytes = await this.fileSystem.readFile(target);
    const captured = decodeSnapshot(relativePath, bytes, current.mode);
    if (captured.sha256 !== current.sha256) {
      throw new DomainError(
        "CONFLICT",
        `File ${relativePath} changed during rollback capture; expected SHA-256 ${current.sha256}`,
      );
    }
    return {
      relativePath,
      bytesBase64: bytes.toString("base64"),
      sha256: current.sha256,
      mode: current.mode,
    };
  }

  /**
   * Restores exact bytes only when the applied file is still unchanged.
   *
   * @example await repository.restoreRollback(snapshot, appliedSha256)
   */
  public async restoreRollback(
    rollback: FileRollbackSnapshot,
    expectedSha256: string,
  ): Promise<TextFileSnapshot> {
    const current = await this.readTextFile(rollback.relativePath);
    if (current.sha256 !== expectedSha256) {
      throw new DomainError(
        "CONFLICT",
        `File ${rollback.relativePath} has SHA-256 ${current.sha256}; expected SHA-256 ${expectedSha256}`,
      );
    }
    const bytes = decodeRollbackBytes(rollback);
    const target = await this.resolveTarget(rollback.relativePath);
    await this.atomicWriter.write(target, bytes, rollback.mode);
    return this.readTextFile(rollback.relativePath);
  }

  private async resolveRoot(): Promise<string> {
    const resolved = await this.fileSystem.realpath(this.root);
    if (!path.isAbsolute(resolved)) {
      throw new DomainError(
        "SECURITY",
        `Resolved root ${safeValue(resolved)}; expected an absolute directory path`,
      );
    }
    return resolved;
  }

  private async resolveTarget(relativePath: string): Promise<string> {
    const root = await this.resolveRoot();
    const candidate = path.resolve(root, relativePath);
    assertContained(root, candidate, relativePath);
    const resolved = await this.fileSystem.realpath(candidate);
    assertContained(root, resolved, relativePath);
    return resolved;
  }

  private async readBoundedFiles(
    relativePaths: readonly string[],
  ): Promise<readonly TextFileSnapshot[]> {
    const files: TextFileSnapshot[] = [];
    let totalBytes = 0;
    for (
      let offset = 0;
      offset < relativePaths.length;
      offset += MAX_READ_CONCURRENCY
    ) {
      const paths = relativePaths.slice(offset, offset + MAX_READ_CONCURRENCY);
      const batch = await Promise.all(
        paths.map((relativePath) => this.readTextFile(relativePath)),
      );
      for (const file of batch) {
        totalBytes += file.byteLength;
        assertTotalBytes(totalBytes);
        files.push(file);
      }
    }
    return files;
  }
}

function validateRelativePath(relativePath: string): void {
  const parts = relativePath.split("/");
  const invalid =
    !relativePath ||
    path.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    parts.some((part) => !part || part === "." || part === "..");
  if (!invalid) return;
  throw new DomainError(
    "SECURITY",
    `Invalid file path ${safeValue(relativePath)}; expected a root-relative text-file path without dot segments`,
  );
}

function validateEligiblePath(relativePath: string): void {
  if (isEligiblePath(relativePath)) return;
  throw new DomainError(
    "SECURITY",
    `Blocked file path ${safeValue(relativePath)}; expected an allowed Markdown or text file`,
  );
}

function isEligiblePath(relativePath: string): boolean {
  const parts = relativePath.split("/");
  const name = parts.at(-1)?.toLowerCase() ?? "";
  if (
    parts.some(
      (part) =>
        part.startsWith(".") || EXCLUDED_DIRECTORIES.has(part.toLowerCase()),
    )
  ) {
    return false;
  }
  const extension = path.extname(name);
  if (!TEXT_EXTENSIONS.has(extension)) return false;
  if (name.startsWith(".env") || SENSITIVE_NAME.test(name)) return false;
  return !SENSITIVE_EXTENSION.has(extension);
}

function assertContained(root: string, target: string, input: string): void {
  const relative = path.relative(root, target);
  if (
    relative &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  ) {
    return;
  }
  if (!relative) return;
  throw new DomainError(
    "SECURITY",
    `File path ${safeValue(input)} resolved outside selected root; expected a contained real path`,
  );
}

function validateMetadata(relativePath: string, metadata: FileMetadata): void {
  if (!metadata.isFile) {
    throw new DomainError(
      "SECURITY",
      `File ${relativePath} is not a regular file; expected a regular text file`,
    );
  }
  if (metadata.size > MAX_FILE_BYTES) {
    throw new DomainError(
      "LIMIT_EXCEEDED",
      `File ${relativePath} is ${metadata.size} bytes; expected at most ${MAX_FILE_BYTES}`,
    );
  }
}

function assertTotalBytes(totalBytes: number): void {
  if (totalBytes <= MAX_TOTAL_BYTES) return;
  throw new DomainError(
    "LIMIT_EXCEEDED",
    `Workspace scan reached ${totalBytes} bytes; expected at most ${MAX_TOTAL_BYTES}`,
  );
}

function decodeSnapshot(
  relativePath: string,
  bytes: Buffer,
  mode: number,
): TextFileSnapshot {
  if (bytes.length > MAX_FILE_BYTES) {
    throw new DomainError(
      "LIMIT_EXCEEDED",
      `File ${relativePath} is ${bytes.length} bytes; expected at most ${MAX_FILE_BYTES}`,
    );
  }
  if (bytes.includes(0)) {
    throw new DomainError(
      "VALIDATION",
      `File ${relativePath} contains NUL bytes; expected UTF-8 text`,
    );
  }
  const hasBom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  const payload = hasBom ? bytes.subarray(3) : bytes;
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch (error: unknown) {
    throw new DomainError(
      "VALIDATION",
      `File ${relativePath} has invalid UTF-8 bytes; expected UTF-8 or UTF-8 BOM`,
      error,
    );
  }
  const lineEnding = detectLineEnding(relativePath, content);
  return {
    relativePath,
    content,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.length,
    hasBom,
    lineEnding,
    hasFinalNewline: content.endsWith("\n"),
    mode,
  };
}

function detectLineEnding(
  relativePath: string,
  content: string,
): "LF" | "CRLF" {
  const withoutCrlf = content.replace(/\r\n/g, "");
  if (withoutCrlf.includes("\r")) {
    throw new DomainError(
      "VALIDATION",
      `File ${relativePath} contains bare CR line endings; expected LF or CRLF`,
    );
  }
  if (content.includes("\r\n") && withoutCrlf.includes("\n")) {
    throw new DomainError(
      "VALIDATION",
      `File ${relativePath} mixes LF and CRLF; expected one line-ending style`,
    );
  }
  return content.includes("\r\n") ? "CRLF" : "LF";
}

function encodeReplacement(
  replacement: string,
  original: TextFileSnapshot,
): Buffer {
  let normalized = replacement.replace(/\r\n?/g, "\n");
  normalized = original.hasFinalNewline
    ? `${normalized.replace(/\n+$/g, "")}\n`
    : normalized.replace(/\n+$/g, "");
  if (original.lineEnding === "CRLF")
    normalized = normalized.replace(/\n/g, "\r\n");
  const body = Buffer.from(normalized, "utf8");
  const encoded = original.hasBom
    ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body])
    : body;
  return assertBoundedReplacement(original.relativePath, encoded);
}

function assertBoundedReplacement(relativePath: string, bytes: Buffer): Buffer {
  if (bytes.length <= MAX_FILE_BYTES) return bytes;
  throw new DomainError(
    "LIMIT_EXCEEDED",
    `Replacement for ${relativePath} is ${bytes.length} bytes; expected at most ${MAX_FILE_BYTES}`,
  );
}

function findMatches(
  file: TextFileSnapshot,
  query: string,
): readonly TextSearchMatch[] {
  const needle = query.toLocaleLowerCase();
  const matches: TextSearchMatch[] = [];
  for (const [index, line] of file.content.split(/\r?\n/).entries()) {
    if (!line.toLocaleLowerCase().includes(needle)) continue;
    matches.push({
      relativePath: file.relativePath,
      line: index + 1,
      preview: line.slice(0, 500),
    });
  }
  return matches;
}

function decodeRollbackBytes(rollback: FileRollbackSnapshot): Buffer {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      rollback.bytesBase64,
    )
  ) {
    throw new DomainError(
      "VALIDATION",
      `Invalid rollback for ${rollback.relativePath}; expected base64 source bytes`,
    );
  }
  const bytes = Buffer.from(rollback.bytesBase64, "base64");
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== rollback.sha256) {
    throw new DomainError(
      "VALIDATION",
      `Rollback for ${rollback.relativePath} has SHA-256 ${hash}; expected SHA-256 ${rollback.sha256}`,
    );
  }
  if (bytes.length > MAX_FILE_BYTES) {
    throw new DomainError(
      "LIMIT_EXCEEDED",
      `Rollback for ${rollback.relativePath} is ${bytes.length} bytes; expected at most ${MAX_FILE_BYTES}`,
    );
  }
  decodeSnapshot(rollback.relativePath, bytes, rollback.mode);
  return bytes;
}
