import { describe, expect, test } from "bun:test";
import { queryTokens, snippet } from "../src/data/conversations";
import { conversationLocked, stampLocked } from "../src/data/locks";
import { reportTitle } from "../src/data/project";

describe("keyword search", () => {
  test("keeps words of four letters or more, once, in order, at most four", () => {
    expect(queryTokens("The charging, charging POINTS near buses and grid-connection")).toEqual([
      "charging",
      "points",
      "near",
      "buses",
    ]);
    expect(queryTokens("a of the")).toEqual([]);
  });

  test("a snippet centres on the first token found and marks the cuts", () => {
    const text = `${"x".repeat(100)} charging point ${"y".repeat(100)}`;
    const s = snippet(text, ["charging"]);
    expect(s.startsWith("...")).toBe(true);
    expect(s.endsWith("...")).toBe(true);
    expect(s).toContain("charging point");
    expect(snippet("short text", ["absent"])).toBe("short text");
  });
});

describe("free tier lock", () => {
  test("the over-cap stamp locks only on an hour-capped tier", () => {
    expect(stampLocked(true, "free")).toBe(true);
    expect(stampLocked(true, "changemaker")).toBe(false);
    expect(stampLocked(true, null)).toBe(false);
    expect(stampLocked(false, "free")).toBe(false);
  });

  test("a recording conversation locks on the live cap", () => {
    expect(conversationLocked({ is_over_cap: false, is_finished: false }, "free", true)).toBe(true);
    expect(conversationLocked({ is_over_cap: false, is_finished: true }, "free", true)).toBe(false);
  });
});

describe("report title", () => {
  test("is the first H1", () => {
    expect(reportTitle("intro\n# City listening\n# Other")).toBe("City listening");
    expect(reportTitle("## not a title")).toBeNull();
    expect(reportTitle(null)).toBeNull();
  });
});
