import {
  ChangeApplier,
  type FileWorkspaceWritePort,
  type FileWorkspaceWriteResolver,
  InMemoryRollbackStore,
} from "../../src/agent/changeApplier";
import type {
  FileRollbackSnapshot,
  TextFileSnapshot,
  TextSearchMatch,
} from "../../src/fileWorkspace/fileWorkspaceRepository";
import type {
  CreateNoteInput,
  NoteRecord,
  NoteRepository,
  NoteSearchHit,
  NotebookRecord,
  UpdateNoteBodyInput,
} from "../../src/notes/retriever";
import { InMemoryChangeSetStore } from "../../src/persistence/changeSetStore";

class UnusedNoteRepository implements NoteRepository {
  public async searchNotes(): Promise<readonly NoteSearchHit[]> {
    return [];
  }
  public async readNote(): Promise<NoteRecord> {
    throw new Error("No note changes expected");
  }
  public async listNotebooks(): Promise<readonly NotebookRecord[]> {
    return [];
  }
  public async createNote(_input: CreateNoteInput): Promise<NoteRecord> {
    throw new Error("No note changes expected");
  }
  public async updateNoteBody(
    _input: UpdateNoteBodyInput,
  ): Promise<NoteRecord> {
    throw new Error("No note changes expected");
  }
}

function snapshot(
  path: string,
  content: string,
  sha256: string,
): TextFileSnapshot {
  return {
    relativePath: path,
    content,
    sha256,
    byteLength: Buffer.byteLength(content),
    hasBom: false,
    lineEnding: "LF",
    hasFinalNewline: false,
    mode: 0o644,
  };
}

class FakeFileWorkspace implements FileWorkspaceWritePort {
  public readonly files = new Map<string, TextFileSnapshot>([
    ["good.md", snapshot("good.md", "Good original", "good-hash")],
    ["conflict.md", snapshot("conflict.md", "Changed elsewhere", "new-hash")],
  ]);

  public async listTextFiles(): Promise<readonly TextFileSnapshot[]> {
    return [...this.files.values()];
  }
  public async readTextFile(path: string): Promise<TextFileSnapshot> {
    const file = this.files.get(path);
    if (!file) throw new Error(`Missing ${path}`);
    return file;
  }
  public async searchTextFiles(): Promise<readonly TextSearchMatch[]> {
    return [];
  }
  public async writeTextFile(
    path: string,
    replacement: string,
    expectedSha256: string,
  ): Promise<TextFileSnapshot> {
    const current = await this.readTextFile(path);
    if (current.sha256 !== expectedSha256) throw new Error("hash conflict");
    const next = snapshot(path, replacement, `applied-${path}`);
    this.files.set(path, next);
    return next;
  }
  public async captureRollback(path: string): Promise<FileRollbackSnapshot> {
    const current = await this.readTextFile(path);
    return {
      relativePath: path,
      bytesBase64: Buffer.from(current.content).toString("base64"),
      sha256: current.sha256,
      mode: current.mode,
    };
  }
  public async restoreRollback(
    rollback: FileRollbackSnapshot,
    expectedSha256: string,
  ): Promise<TextFileSnapshot> {
    const current = await this.readTextFile(rollback.relativePath);
    if (current.sha256 !== expectedSha256) throw new Error("undo conflict");
    const restored = snapshot(
      rollback.relativePath,
      Buffer.from(rollback.bytesBase64, "base64").toString(),
      rollback.sha256,
    );
    this.files.set(rollback.relativePath, restored);
    return restored;
  }
}

class FakeFileWorkspaceResolver implements FileWorkspaceWriteResolver {
  public constructor(private readonly workspace: FakeFileWorkspace) {}
  public resolve(): FileWorkspaceWritePort {
    return this.workspace;
  }
}

describe("ChangeApplier", () => {
  test("applies independent files, reports conflicts, and undoes exact originals", async () => {
    const changes = new InMemoryChangeSetStore();
    const good = changes.add("chat-1", "run-1", {
      kind: "file",
      relativePath: "good.md",
      targetLabel: "good.md",
      before: "Good original",
      after: "Good improved",
      expectedSha256: "good-hash",
    });
    const conflict = changes.add("chat-1", "run-1", {
      kind: "file",
      relativePath: "conflict.md",
      targetLabel: "conflict.md",
      before: "Old original",
      after: "Unsafe overwrite",
      expectedSha256: "old-hash",
    });
    const workspace = new FakeFileWorkspace();
    const applier = new ChangeApplier(
      changes,
      new UnusedNoteRepository(),
      new FakeFileWorkspaceResolver(workspace),
      new InMemoryRollbackStore(),
    );
    const changeSet = changes.getByRun("run-1");
    if (!changeSet) throw new Error("Expected change set");

    const result = await applier.apply(changeSet.id, [good.id, conflict.id], {
      chatId: "chat-1",
      runId: "run-1",
    });

    expect(result.changes.map((change) => change.status)).toEqual([
      "applied",
      "conflict",
    ]);
    expect(workspace.files.get("good.md")?.content).toBe("Good improved");
    expect(workspace.files.get("conflict.md")?.content).toBe(
      "Changed elsewhere",
    );

    expect(result.undoAvailable).toBe(true);
    await applier.undo("run-1", "chat-1");

    expect(workspace.files.get("good.md")?.content).toBe("Good original");
  });
});
