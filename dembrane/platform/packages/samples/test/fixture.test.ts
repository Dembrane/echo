import { describe, expect, test } from "bun:test";
import chat from "../fixtures/millbrook/chat.json";
import conversations from "../fixtures/millbrook/conversations.json";
import project from "../fixtures/millbrook/project.json";
import report from "../fixtures/millbrook/report.md" with { type: "text" };
import { MILLBROOK } from "../src";

// Every preview shows this fixture to reviewers and anyone they share a link with, so it
// must carry nothing that looks like a real person, contact or organisation.
const everything = [
  project.context,
  ...conversations.flatMap((c) => [c.name, c.summary, ...c.chunks.map((x) => x.text)]),
  chat.name,
  ...chat.turns.map((t) => t.text),
  report,
].join("\n");

describe("the Millbrook fixture", () => {
  test("names its org, workspace and project as samples", () => {
    expect(MILLBROOK.org).toBe("Acme Civic (sample)");
    expect(MILLBROOK.workspace).toContain("(sample)");
    expect(MILLBROOK.project).toContain("(sample)");
  });

  test("is generated end to end: 25 conversations, a report and a chat that quotes them", () => {
    expect(conversations).toHaveLength(25);
    expect(new Set(conversations.map((c) => c.key)).size).toBe(25);
    for (const c of conversations) {
      expect(c.origin).toBe("generated");
      expect(c.chunks.length).toBeGreaterThanOrEqual(25);
      expect(c.summary).toContain("Synthetic sample");
    }
    expect(report).toContain("Synthetic sample");
    const keys = new Set(conversations.map((c) => c.key));
    for (const k of chat.conversation_keys) expect(keys.has(k)).toBe(true);
    expect(chat.turns.map((t) => t.from)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  test("carries no contact details and no dembrane names", () => {
    expect(everything).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(everything).not.toMatch(/https?:\/\//);
    expect(everything).not.toMatch(/\+?\d[\d ()-]{8,}\d/);
    expect(everything.toLowerCase()).not.toContain("dembrane");
    expect(everything).not.toContain("Hybrid Town Hall");
  });
});
