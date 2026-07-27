import type Joplin from "api/Joplin";
import { JoplinDataAdapter } from "../../src/plugin/joplinPorts";

class RecordingJoplinData {
  public readonly deleteCalls: {
    readonly path: string[];
    readonly query?: Record<string, unknown>;
  }[] = [];

  public async delete(
    path: string[],
    query?: Record<string, unknown>,
  ): Promise<unknown> {
    this.deleteCalls.push({ path, ...(query ? { query } : {}) });
    return { ok: true };
  }
}

describe("Joplin data adapter", () => {
  test("delegates recoverable deletion without a permanent flag", async () => {
    const data = new RecordingJoplinData();
    const joplin = { data } as unknown as Joplin;
    const adapter = new JoplinDataAdapter(joplin);

    await expect(adapter.delete(["notes", "note-1"])).resolves.toEqual({
      ok: true,
    });
    expect(data.deleteCalls).toEqual([{ path: ["notes", "note-1"] }]);
  });
});
