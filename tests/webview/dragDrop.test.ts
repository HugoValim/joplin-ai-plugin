import { parseDroppedReference } from "../../src/webview/dragDrop";

class FakeDataTransfer {
  public constructor(
    private readonly text: string,
    public readonly types: readonly string[] = ["text/plain"],
  ) {}

  public getData(format: string): string {
    return format === "text/plain" || format === "text" ? this.text : "";
  }
}

describe("parseDroppedReference", () => {
  test("parses a note id from dropped text", () => {
    const candidate = parseDroppedReference(
      new FakeDataTransfer("Deploy guide abc123def456gh789ijkl"),
      "note",
    );
    expect(candidate).toEqual({
      kind: "note",
      id: "abc123def456gh789ijkl",
      title: "Deploy guide abc123def456gh789ijkl",
    });
  });

  test("returns null when the drop has no recognisable id", () => {
    expect(
      parseDroppedReference(new FakeDataTransfer("hi"), "note"),
    ).toBeNull();
  });

  test("returns null when the drop has no text", () => {
    expect(
      parseDroppedReference(new FakeDataTransfer("", []), "note"),
    ).toBeNull();
  });
});
