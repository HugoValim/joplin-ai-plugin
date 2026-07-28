/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RunActivity } from "../../src/webview/RunStatus";
import type { ToolActivity } from "../../src/webview/sidebarState";

function tool(
  id: string,
  name: string,
  status: ToolActivity["status"] = "completed",
): ToolActivity {
  return { id, name, status };
}

describe("RunActivity", () => {
  test("renders one collapsed summary line by default", () => {
    render(
      <RunActivity
        progress="Model step 61 of 200"
        tools={[
          tool("search-1", "search_notes"),
          tool("read-1", "read_note", "running"),
        ]}
        plan={[]}
        failure={null}
        canRetry={false}
      />,
    );

    const details = screen.getByLabelText("Run activity").querySelector("details");
    if (!details) throw new Error("Expected run activity details");
    expect(details.open).toBe(false);
    expect(screen.getByText("Model step 61 of 200 · read_note · search_notes, read_note")).toBeTruthy();
    expect(screen.queryByText("Completed")).toBeNull();
  });

  test("expands to show the full tool list", async () => {
    const user = userEvent.setup();
    render(
      <RunActivity
        progress="Thinking"
        tools={[
          tool("search-1", "search_notes"),
          tool("read-1", "read_note"),
        ]}
        plan={[]}
        failure={null}
        canRetry={false}
      />,
    );

    await user.click(screen.getByText("Thinking · read_note · search_notes, read_note"));
    expect(screen.getAllByText("search_notes").length).toBeGreaterThan(0);
    expect(screen.getAllByText("completed").length).toBe(2);
  });

  test("keeps failures visible outside the collapsed tracker", () => {
    render(
      <RunActivity
        progress=""
        tools={[]}
        plan={[]}
        failure={{ code: "PROVIDER", message: "Endpoint unavailable" }}
        canRetry
        onRetry={jest.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(document.querySelector(".run-activity-details")).toBeNull();
  });

  test("renders an expandable agent plan checklist", async () => {
    const user = userEvent.setup();
    render(
      <RunActivity
        progress=""
        tools={[]}
        plan={[
          { id: "1", content: "Improve FWS notes", status: "completed" },
          { id: "2", content: "Tighten roadmap", status: "pending" },
        ]}
        failure={null}
        canRetry={false}
      />,
    );

    expect(
      screen.getByText("Plan 1/2 done · 0 active · 1 pending"),
    ).toBeTruthy();
    await user.click(screen.getByText("Plan 1/2 done · 0 active · 1 pending"));
    expect(screen.getByText("Improve FWS notes")).toBeTruthy();
    expect(screen.getByText("Tighten roadmap")).toBeTruthy();
  });
});
