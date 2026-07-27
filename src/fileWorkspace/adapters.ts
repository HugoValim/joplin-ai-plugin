import path from "path";
import fastGlob from "fast-glob";
import createIgnore from "ignore";
import writeFileAtomic from "write-file-atomic";
import type {
  AtomicWritePort,
  FileCandidateFinder,
  FileMetadata,
  FileSystemPort,
} from "./fileWorkspaceRepository";

interface FsExtraStat {
  readonly size: number;
  readonly mode: number;
  isFile(): boolean;
}

export interface JoplinFsExtra {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<FsExtraStat>;
  readFile(path: string): Promise<Buffer>;
}

export interface GlobPort {
  find(
    patterns: readonly string[],
    options: {
      readonly cwd: string;
      readonly dot: boolean;
      readonly followSymbolicLinks: boolean;
      readonly onlyFiles: boolean;
      readonly unique: boolean;
    },
  ): Promise<readonly string[]>;
}

class FastGlobPort implements GlobPort {
  public find(
    patterns: readonly string[],
    options: Parameters<GlobPort["find"]>[1],
  ): Promise<readonly string[]> {
    return fastGlob([...patterns], options);
  }
}

export class JoplinFileSystemAdapter implements FileSystemPort {
  public constructor(private readonly fsExtra: JoplinFsExtra) {}

  public realpath(inputPath: string): Promise<string> {
    return this.fsExtra.realpath(inputPath);
  }

  public async stat(inputPath: string): Promise<FileMetadata> {
    const metadata = await this.fsExtra.stat(inputPath);
    return {
      size: metadata.size,
      mode: metadata.mode,
      isFile: metadata.isFile(),
    };
  }

  public readFile(inputPath: string): Promise<Buffer> {
    return this.fsExtra.readFile(inputPath);
  }
}

export class FastGlobCandidateFinder implements FileCandidateFinder {
  public constructor(
    private readonly fileSystem: FileSystemPort,
    private readonly glob: GlobPort = new FastGlobPort(),
  ) {}

  /**
   * Finds text candidates without following symlinks and applies root `.gitignore`.
   *
   * @example await finder.find('/notes', ['docs/*.md'])
   */
  public async find(
    absoluteRoot: string,
    patterns: readonly string[],
  ): Promise<readonly string[]> {
    const candidates = await this.glob.find(patterns, {
      cwd: absoluteRoot,
      dot: true,
      followSymbolicLinks: false,
      onlyFiles: true,
      unique: true,
    });
    const gitignore = await this.readGitignore(absoluteRoot);
    if (!gitignore) return candidates;
    const matcher = createIgnore().add(gitignore);
    return candidates.filter((candidate) => !matcher.ignores(candidate));
  }

  private async readGitignore(absoluteRoot: string): Promise<string> {
    try {
      const content = await this.fileSystem.readFile(
        path.join(absoluteRoot, ".gitignore"),
      );
      return new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      return "";
    }
  }
}

export class WriteFileAtomicAdapter implements AtomicWritePort {
  /**
   * Replaces one file atomically while retaining its permission bits.
   *
   * @example await writer.write('/notes/guide.md', bytes, 0o644)
   */
  public write(
    absolutePath: string,
    bytes: Buffer,
    mode: number,
  ): Promise<void> {
    return writeFileAtomic(absolutePath, bytes, { mode, fsync: true });
  }
}
