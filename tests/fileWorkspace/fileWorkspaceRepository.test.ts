import {
  FileWorkspaceRepository,
  type AtomicWritePort,
  type FileCandidateFinder,
  type FileMetadata,
  type FileSystemPort,
} from "../../src/fileWorkspace/fileWorkspaceRepository";

class UnusedFileSystemPort implements FileSystemPort {
  public async realpath(path: string): Promise<string> {
    throw new Error(`Unexpected realpath for ${path}`);
  }

  public async stat(path: string): Promise<FileMetadata> {
    throw new Error(`Unexpected stat for ${path}`);
  }

  public async readFile(path: string): Promise<Buffer> {
    throw new Error(`Unexpected read for ${path}`);
  }
}

class UnusedFileCandidateFinder implements FileCandidateFinder {
  public async find(): Promise<readonly string[]> {
    return [];
  }
}

class UnusedAtomicWritePort implements AtomicWritePort {
  public async write(): Promise<void> {
    throw new Error("Unexpected write");
  }
}

class MemoryFileSystemPort implements FileSystemPort {
  public readonly files = new Map<string, { bytes: Buffer; mode: number }>();

  public async realpath(path: string): Promise<string> {
    return path;
  }

  public async stat(path: string): Promise<FileMetadata> {
    const file = this.files.get(path);
    if (!file) throw new Error(`Missing file ${path}`);
    return { size: file.bytes.length, mode: file.mode, isFile: true };
  }

  public async readFile(path: string): Promise<Buffer> {
    const file = this.files.get(path);
    if (!file) throw new Error(`Missing file ${path}`);
    return Buffer.from(file.bytes);
  }
}

class FixedFileCandidateFinder implements FileCandidateFinder {
  public constructor(private readonly paths: readonly string[]) {}

  public async find(): Promise<readonly string[]> {
    return this.paths;
  }
}

class MemoryAtomicWritePort implements AtomicWritePort {
  public writeCount = 0;

  public constructor(private readonly fileSystem: MemoryFileSystemPort) {}

  public async write(
    absolutePath: string,
    bytes: Buffer,
    mode: number,
  ): Promise<void> {
    this.writeCount += 1;
    this.fileSystem.files.set(absolutePath, {
      bytes: Buffer.from(bytes),
      mode,
    });
  }
}

class EscapingSymlinkFileSystemPort implements FileSystemPort {
  public async realpath(path: string): Promise<string> {
    if (path === "/workspace") return "/workspace";
    if (path === "/workspace/link.md") return "/outside/secret.md";
    throw new Error(`Unexpected realpath for ${path}`);
  }

  public async stat(path: string): Promise<FileMetadata> {
    throw new Error(`Unexpected stat for ${path}`);
  }

  public async readFile(path: string): Promise<Buffer> {
    throw new Error(`Unexpected read for ${path}`);
  }
}

class ReadGrowthFileSystemPort implements FileSystemPort {
  public async realpath(path: string): Promise<string> {
    return path;
  }

  public async stat(): Promise<FileMetadata> {
    return { size: 1, mode: 0o644, isFile: true };
  }

  public async readFile(): Promise<Buffer> {
    return Buffer.alloc(256 * 1024 + 1, "a");
  }
}

class ConcurrencyTrackingFileSystemPort implements FileSystemPort {
  public activeReads = 0;
  public peakReads = 0;

  public async realpath(path: string): Promise<string> {
    return path;
  }

  public async stat(): Promise<FileMetadata> {
    return { size: 4, mode: 0o644, isFile: true };
  }

  public async readFile(): Promise<Buffer> {
    this.activeReads += 1;
    this.peakReads = Math.max(this.peakReads, this.activeReads);
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.activeReads -= 1;
    return Buffer.from("Text");
  }
}

describe("FileWorkspaceRepository", () => {
  test.each(["../outside.md", "/etc/passwd", "notes/../../outside.txt"])(
    "rejects path traversal before touching the filesystem: %s",
    async (unsafePath) => {
      const repository = new FileWorkspaceRepository(
        "/workspace",
        new UnusedFileSystemPort(),
        new UnusedFileCandidateFinder(),
        new UnusedAtomicWritePort(),
      );

      await expect(repository.readTextFile(unsafePath)).rejects.toThrow(
        "expected a root-relative text-file path",
      );
    },
  );

  test("rejects a symlink whose real path escapes the root", async () => {
    const repository = new FileWorkspaceRepository(
      "/workspace",
      new EscapingSymlinkFileSystemPort(),
      new UnusedFileCandidateFinder(),
      new UnusedAtomicWritePort(),
    );

    await expect(repository.readTextFile("link.md")).rejects.toThrow(
      "resolved outside selected root",
    );
  });

  test("rejects a file that grows beyond its limit after stat", async () => {
    const repository = new FileWorkspaceRepository(
      "/workspace",
      new ReadGrowthFileSystemPort(),
      new UnusedFileCandidateFinder(),
      new UnusedAtomicWritePort(),
    );

    await expect(repository.readTextFile("guide.md")).rejects.toThrow(
      "expected at most 262144",
    );
  });

  test.each([
    ["binary NUL", Buffer.from([0x61, 0x00, 0x62])],
    ["invalid UTF-8", Buffer.from([0xc3, 0x28])],
  ])("rejects %s content", async (_label, bytes) => {
    const fileSystem = new MemoryFileSystemPort();
    fileSystem.files.set("/workspace/guide.md", { bytes, mode: 0o644 });
    const repository = new FileWorkspaceRepository(
      "/workspace",
      fileSystem,
      new UnusedFileCandidateFinder(),
      new UnusedAtomicWritePort(),
    );

    await expect(repository.readTextFile("guide.md")).rejects.toThrow(
      "expected UTF-8",
    );
  });

  test("excludes hidden, dependency, and credential-like files", async () => {
    const fileSystem = new MemoryFileSystemPort();
    for (const relativePath of ["guide.md", "docs/info.txt"]) {
      fileSystem.files.set(`/workspace/${relativePath}`, {
        bytes: Buffer.from("Safe text"),
        mode: 0o644,
      });
    }
    const finder = new FixedFileCandidateFinder([
      "guide.md",
      ".env.txt",
      "node_modules/readme.md",
      "docs/api-key.txt",
      "docs/certificate.md",
      "docs/credentials.txt",
      "docs/info.txt",
    ]);
    const repository = new FileWorkspaceRepository(
      "/workspace",
      fileSystem,
      finder,
      new UnusedAtomicWritePort(),
    );

    const files = await repository.listTextFiles();

    expect(files.map((file) => file.relativePath)).toEqual([
      "docs/info.txt",
      "guide.md",
    ]);
  });

  test("reads bulk candidates with bounded concurrency", async () => {
    const fileSystem = new ConcurrencyTrackingFileSystemPort();
    const paths = Array.from({ length: 5 }, (_, index) => `file-${index}.md`);
    const repository = new FileWorkspaceRepository(
      "/workspace",
      fileSystem,
      new FixedFileCandidateFinder(paths),
      new UnusedAtomicWritePort(),
    );

    expect(await repository.listTextFiles()).toHaveLength(5);
    expect(fileSystem.peakReads).toBe(4);
  });

  test("preserves BOM, CRLF, final newline, and mode on replacement", async () => {
    const fileSystem = new MemoryFileSystemPort();
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    fileSystem.files.set("/workspace/guide.md", {
      bytes: Buffer.concat([bom, Buffer.from("# Old\r\nBody\r\n")]),
      mode: 0o640,
    });
    const writer = new MemoryAtomicWritePort(fileSystem);
    const repository = new FileWorkspaceRepository(
      "/workspace",
      fileSystem,
      new FixedFileCandidateFinder(["guide.md"]),
      writer,
    );
    const before = await repository.readTextFile("guide.md");
    const rollback = await repository.captureRollback("guide.md");

    const applied = await repository.writeTextFile(
      "guide.md",
      "# New\nClearer body",
      before.sha256,
    );

    const written = fileSystem.files.get("/workspace/guide.md");
    expect(written?.bytes).toEqual(
      Buffer.concat([bom, Buffer.from("# New\r\nClearer body\r\n")]),
    );
    expect(written?.mode).toBe(0o640);

    await repository.restoreRollback(rollback, applied.sha256);

    expect(fileSystem.files.get("/workspace/guide.md")?.bytes).toEqual(
      Buffer.concat([bom, Buffer.from("# Old\r\nBody\r\n")]),
    );
  });

  test("does not overwrite a file changed after it was read", async () => {
    const fileSystem = new MemoryFileSystemPort();
    fileSystem.files.set("/workspace/guide.md", {
      bytes: Buffer.from("Original"),
      mode: 0o644,
    });
    const writer = new MemoryAtomicWritePort(fileSystem);
    const repository = new FileWorkspaceRepository(
      "/workspace",
      fileSystem,
      new FixedFileCandidateFinder(["guide.md"]),
      writer,
    );
    const before = await repository.readTextFile("guide.md");
    fileSystem.files.set("/workspace/guide.md", {
      bytes: Buffer.from("Changed concurrently"),
      mode: 0o644,
    });

    await expect(
      repository.writeTextFile("guide.md", "Proposed", before.sha256),
    ).rejects.toThrow("expected SHA-256");
    expect(writer.writeCount).toBe(0);
  });

  test("rejects an oversized replacement before writing", async () => {
    const fileSystem = new MemoryFileSystemPort();
    fileSystem.files.set("/workspace/guide.md", {
      bytes: Buffer.from("Original"),
      mode: 0o644,
    });
    const writer = new MemoryAtomicWritePort(fileSystem);
    const repository = new FileWorkspaceRepository(
      "/workspace",
      fileSystem,
      new FixedFileCandidateFinder(["guide.md"]),
      writer,
    );
    const before = await repository.readTextFile("guide.md");

    await expect(
      repository.writeTextFile(
        "guide.md",
        "a".repeat(256 * 1024 + 1),
        before.sha256,
      ),
    ).rejects.toThrow("Replacement for guide.md");
    expect(writer.writeCount).toBe(0);
  });
});
