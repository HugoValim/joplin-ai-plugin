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

  test("lets transcript messages grow with panel width instead of hard ch caps", () => {
    const css = readFileSync(resolve("src/webview/message.css"), "utf8");
    expect(css).not.toMatch(/max-width:\s*min\([^)]*72ch/);
    expect(css).not.toMatch(/max-width:\s*min\([^)]*56ch/);
    expect(css).toMatch(/\.message\s*\{[^}]*max-width:\s*94%/s);
    expect(css).toMatch(/\.message-user\s*\{[^}]*max-width:\s*86%/s);
    expect(css).toMatch(/\.run-activity\s*\{[^}]*width:\s*100%/s);
  });

  test("lets tables and pre blocks use available width with overflow scrolling", () => {
    const css = readFileSync(resolve("src/webview/message.css"), "utf8");
    expect(css).toMatch(/\.message-content pre\s*\{[^}]*overflow-x:\s*auto/s);
    expect(css).toMatch(/\.message-content table\s*\{[^}]*overflow-x:\s*auto/s);
  });

  test("preserves the narrow-panel min-width guard at 280px", () => {
    const css = readFileSync(resolve("src/webview/layout.css"), "utf8");
    expect(css).toMatch(/@media\s*\(max-width:\s*279px\)/);
    expect(css).toMatch(/\.panel-width-guard\s*\{[^}]*display:\s*grid/s);
  });
});
