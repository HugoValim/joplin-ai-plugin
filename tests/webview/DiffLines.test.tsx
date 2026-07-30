/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { DiffLines } from "../../src/webview/DiffLines";

describe("DiffLines", () => {
  test("renders add lines green and del lines red", () => {
    render(
      <DiffLines
        diff={"@@ -1 +1 @@\n-removed\n+added\n context"}
        maxLines={200}
      />,
    );

    const del = screen.getByText("-removed");
    const add = screen.getByText("+added");
    const ctx = screen.getByText((content) => content.trim() === "context");
    expect(del.className).toContain("diff-del");
    expect(add.className).toContain("diff-add");
    expect(ctx.className).toContain("diff-ctx");
  });
});
