import type {
  TextFileSnapshot,
  TextSearchMatch,
} from "../../src/fileWorkspace/fileWorkspaceRepository";
import { toolContext } from "../helpers/toolContext";
import { InMemoryChangeSetStore } from "../../src/persistence/changeSetStore";
import {
  registerFileTools,
  type FileWorkspacePort,
  type FileWorkspaceResolver,
} from "../../src/tools/fileTools";
import { ToolRegistry } from "../../src/tools/toolRegistry";

const SNAPSHOT: TextFileSnapshot = {
  relativePath: "guide.md",
  content: "# Guide\nOld text.",
  sha256: "original-hash",
  byteLength: 17,
  hasBom: false,
  lineEnding: "LF",
  hasFinalNewline: false,
  mode: 0o644,
};

class FakeFileWorkspace implements FileWorkspacePort {
  public constructor(private readonly snapshot = SNAPSHOT) {}

  public async listTextFiles(): Promise<readonly TextFileSnapshot[]> {
    return [this.snapshot];
  }

  public async readTextFile(): Promise<TextFileSnapshot> {
    return this.snapshot;
  }

  public async searchTextFiles(): Promise<readonly TextSearchMatch[]> {
    return [];
  }
}

class FakeFileWorkspaceResolver implements FileWorkspaceResolver {
  public constructor(private readonly snapshot = SNAPSHOT) {}

  public resolve(): FileWorkspacePort {
    return new FakeFileWorkspace(this.snapshot);
  }
}

describe("file proposal tools", () => {
  test("bulk review collects one batch and performs no writes", async () => {
    const changes = new InMemoryChangeSetStore();
    const registry = new ToolRegistry();
    registerFileTools(registry, new FakeFileWorkspaceResolver(), changes);

    const result = await registry.execute(
      {
        id: "call-1",
        name: "review_text_files",
        arguments: {
          edits: [
            {
              relative_path: "guide.md",
              expected_sha256: "original-hash",
              replacement: "# Guide\nClear text.",
            },
          ],
        },
      },
      toolContext({ hasFileWorkspace: true }),
    );

    expect(result.output).toMatchObject({ file_count: 1, total_bytes: 17 });
    expect(changes.getByRun("run-1")?.changes).toHaveLength(1);
  });

  test("rejects duplicate file edits in one bulk review", async () => {
    const registry = new ToolRegistry();
    registerFileTools(
      registry,
      new FakeFileWorkspaceResolver(),
      new InMemoryChangeSetStore(),
    );
    const duplicate = {
      relative_path: "guide.md",
      expected_sha256: "original-hash",
      replacement: "# Guide\nClear text.",
    };

    await expect(
      registry.execute(
        {
          id: "call-1",
          name: "review_text_files",
          arguments: { edits: [duplicate, duplicate] },
        },
        toolContext({ hasFileWorkspace: true }),
      ),
    ).rejects.toThrow("expected one replacement per file");
  });

  test("rejects changes inside protected Markdown code fences", async () => {
    const fenced: TextFileSnapshot = {
      ...SNAPSHOT,
      content: "# Guide\n```ts\nconst value = 1;\n```\nOld text.",
    };
    const registry = new ToolRegistry();
    registerFileTools(
      registry,
      new FakeFileWorkspaceResolver(fenced),
      new InMemoryChangeSetStore(),
    );

    await expect(
      registry.execute(
        {
          id: "call-1",
          name: "propose_file_replacement",
          arguments: {
            relative_path: "guide.md",
            expected_sha256: "original-hash",
            replacement: "# Guide\n```ts\nconst value = 2;\n```\nClear text.",
          },
        },
        toolContext({ hasFileWorkspace: true }),
      ),
    ).rejects.toThrow("protected Markdown structure");
  });
});
