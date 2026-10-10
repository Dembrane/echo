import { describe, expect, test } from "bun:test";
import chat from "../fixtures/best-practices/chat.json";
import conversations from "../fixtures/best-practices/conversations.json";
import project from "../fixtures/best-practices/project.json";
import { BEST_PRACTICES, BEST_PRACTICES_IDS, BEST_PRACTICES_VERSION } from "../src";

// Every workspace gets this fixture, so its shape is what the real content must keep: the
// Millbrook format for conversations and the project, plus a chat that quotes them.
const everything = [
  project.context,
  ...conversations.flatMap((c) => [c.name, c.summary, ...c.chunks.map((x) => x.text)]),
  chat.name,
  ...chat.turns.map((t) => t.text),
].join("\n");

describe("the best-practices fixture", () => {
  test("is a disclosed sample named as one", () => {
    expect(project.synthetic).toBe(true);
    expect(project.project).toBe("Best practices (sample)");
    expect(project.language).toBe("en");
    expect(project.disclosure).toBe(
      "This is a sample project. The organisations, people and conversations in it are invented.",
    );
    expect(project.provenance.length).toBeGreaterThan(0);
    expect(project.context.length).toBeGreaterThan(100);
    expect(BEST_PRACTICES.project).toBe(project.project);
  });

  test("has conversations in the Millbrook shape: unique keys, a summary, timed chunks", () => {
    expect(conversations.length).toBeGreaterThan(0);
    expect(new Set(conversations.map((c) => c.key)).size).toBe(conversations.length);
    for (const c of conversations) {
      expect(c.key).toMatch(/^[a-z0-9-]+$/);
      expect(c.name.trim().length).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(c.started_at))).toBe(false);
      expect(c.summary.trim().length).toBeGreaterThan(50);
      expect(c.chunks.length).toBeGreaterThan(0);
      const times = c.chunks.map((x) => x.at_s);
      expect(times).toEqual([...times].sort((a, b) => a - b));
      for (const x of c.chunks) expect(x.text.trim().length).toBeGreaterThan(0);
    }
  });

  test("seeds a chat that opens on the fixed question and answers from the conversations", () => {
    const keys = new Set(conversations.map((c) => c.key));
    expect(chat.conversation_keys.length).toBeGreaterThan(0);
    for (const k of chat.conversation_keys) expect(keys.has(k)).toBe(true);
    expect(chat.turns[0]).toEqual({
      from: "user",
      text: "How do other organisations use dembrane, and how should I set up my first project?",
    });
    expect(chat.turns.map((t) => t.from)).toEqual(
      chat.turns.map((_, i) => (i % 2 ? "assistant" : "user")),
    );
    const answer = chat.turns[1]?.text ?? "";
    expect(answer).toMatch(/^1\. /m);
    // Each numbered point names a conversation it draws on.
    const names = conversations.map((c) => c.name);
    for (const point of answer.split(/\n\n(?=\d+\. )/).filter((p) => /^\d+\. /.test(p)))
      expect(names.some((n) => point.includes(n))).toBe(true);
  });

  test("carries no contact details", () => {
    expect(everything).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(everything).not.toMatch(/https?:\/\//);
    expect(everything).not.toMatch(/\+?\d[\d ()-]{8,}\d/);
  });

  // Users read this as dembrane talking about itself, so it follows the brand guidelines.
  test("writes dembrane in lowercase and uses no em dashes", () => {
    expect(everything).not.toContain("Dembrane");
    expect(everything).not.toContain("—");
    for (const c of conversations) expect(c.summary.startsWith("Synthetic sample.")).toBe(true);
  });

  test("names its rows after the workspace and stamps copies with the fixture", () => {
    const a = "3f1b7e0a-5c1d-4e6f-9a2b-0c4d8e6f1a2b";
    const b = "7c2d9e1f-6a3b-4c5d-8e7f-1a2b3c4d5e6f";
    expect(BEST_PRACTICES_IDS.project(a)).toBe(BEST_PRACTICES_IDS.project(a));
    expect(BEST_PRACTICES_IDS.project(a)).not.toBe(BEST_PRACTICES_IDS.project(b));
    expect(BEST_PRACTICES_IDS.chat(a)).not.toBe(BEST_PRACTICES_IDS.chat(b));
    expect(BEST_PRACTICES_IDS.conversation(a, "x")).not.toBe(
      BEST_PRACTICES_IDS.conversation(a, "y"),
    );
    expect(BEST_PRACTICES_VERSION).toMatch(/^best-practices@[0-9a-f]{16}$/);
    expect(BEST_PRACTICES_VERSION.length).toBeLessThanOrEqual(64);
  });
});
