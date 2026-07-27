import writeFileAtomic from "write-file-atomic";
import type { JsonFilePort } from "./chatStore";

export interface PersistenceFsExtra {
  ensureDir(path: string): Promise<void>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  rename(source: string, destination: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export class JoplinJsonFileAdapter implements JsonFilePort {
  public constructor(private readonly fsExtra: PersistenceFsExtra) {}

  public ensureDirectory(directoryPath: string): Promise<void> {
    return this.fsExtra.ensureDir(directoryPath);
  }

  public async readText(filePath: string): Promise<string | null> {
    try {
      return await this.fsExtra.readFile(filePath, "utf8");
    } catch (error: unknown) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  public writeTextAtomic(filePath: string, content: string): Promise<void> {
    return writeFileAtomic(filePath, content, {
      encoding: "utf8",
      fsync: true,
    });
  }

  public rename(source: string, destination: string): Promise<void> {
    return this.fsExtra.rename(source, destination);
  }

  public removeFile(filePath: string): Promise<void> {
    return this.fsExtra.remove(filePath);
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
