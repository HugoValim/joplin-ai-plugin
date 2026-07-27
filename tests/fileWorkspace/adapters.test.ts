import {
  FastGlobCandidateFinder,
  type GlobPort,
} from "../../src/fileWorkspace/adapters";
import type {
  FileMetadata,
  FileSystemPort,
} from "../../src/fileWorkspace/fileWorkspaceRepository";

class GitignoreFileSystemPort implements FileSystemPort {
  public async realpath(path: string): Promise<string> {
    return path;
  }

  public async stat(): Promise<FileMetadata> {
    throw new Error("Unexpected stat");
  }

  public async readFile(path: string): Promise<Buffer> {
    if (path === "/workspace/.gitignore") {
      return Buffer.from("private.md\ndrafts/\n");
    }
    throw new Error(`Unexpected read ${path}`);
  }
}

class FixedGlobPort implements GlobPort {
  public async find(): Promise<readonly string[]> {
    return ["guide.md", "private.md", "drafts/idea.md"];
  }
}

describe("FastGlobCandidateFinder", () => {
  test("applies the selected root gitignore before files are read", async () => {
    const finder = new FastGlobCandidateFinder(
      new GitignoreFileSystemPort(),
      new FixedGlobPort(),
    );

    await expect(finder.find("/workspace", ["**/*.md"])).resolves.toEqual([
      "guide.md",
    ]);
  });
});
