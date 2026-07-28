import { SecretNotebookStore } from "../../src/persistence/secretNotebookStore";

class MemorySecretJsonPort {
  public readonly files = new Map<string, string>();

  public async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  public async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
}

describe("SecretNotebookStore", () => {
  test("starts empty and persists marked notebook IDs", async () => {
    const files = new MemorySecretJsonPort();
    const store = new SecretNotebookStore(files);

    expect([...(await store.list())]).toEqual([]);

    const marked = await store.mark("nb-secret");
    expect([...marked]).toEqual(["nb-secret"]);
    expect(JSON.parse(files.files.get("secretNotebooks.json") ?? "{}")).toEqual({
      notebookIds: ["nb-secret"],
    });

    const unmarked = await store.unmark("nb-secret");
    expect([...unmarked]).toEqual([]);
  });

  test("rejects invalid persisted payloads", async () => {
    const files = new MemorySecretJsonPort();
    files.files.set("secretNotebooks.json", '{"notebookIds":"not-an-array"}');
    const store = new SecretNotebookStore(files);

    await expect(store.list()).rejects.toThrow("Invalid secret notebook store");
  });
});
