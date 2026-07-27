/** @jest-environment jsdom */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("panel layout", () => {
  test("constrains Joplin host wrappers to the panel viewport", () => {
    const style = document.createElement("style");
    style.textContent = readFileSync(resolve("src/webview/base.css"), "utf8");
    document.head.append(style);
    document.body.innerHTML =
      '<div id="joplin-plugin-content-root"><div id="joplin-plugin-content"><div id="root"></div></div></div>';

    for (const id of [
      "joplin-plugin-content-root",
      "joplin-plugin-content",
      "root",
    ]) {
      const computed = getComputedStyle(document.getElementById(id)!);
      expect(computed.height).toBe("100%");
      expect(computed.overflow).toBe("hidden");
    }
  });
});
