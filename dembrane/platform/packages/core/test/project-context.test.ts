import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { contextForPrompt, cutAtBoundary, PROJECT_CONTEXT_BUDGET } from "../src";

// ECHO-1055: every prompt reads the project context through one budget.

describe("contextForPrompt", () => {
  test("a context within the budget comes back byte for byte", () => {
    const samples = [
      "",
      "  Bewonersavond Strijp-S, 12 tafels.  \n\n",
      "Ünïcödé — “quotes” and emoji 🎉 stay as they are.\r\n",
      "x".repeat(PROJECT_CONTEXT_BUDGET),
    ];
    for (const s of samples) expect(contextForPrompt(s)).toBe(s);
  });

  test("no context is null", () => {
    expect(contextForPrompt(null)).toBeNull();
    expect(contextForPrompt(undefined)).toBeNull();
    expect(contextForPrompt(42)).toBeNull();
  });

  test("a long context is cut at a line boundary inside the budget", () => {
    const line = "Agenda item about the heat network and the new bus lane.";
    const text = Array.from({ length: 200 }, (_, i) => `${i + 1}. ${line}`).join("\n");
    const out = contextForPrompt(text) as string;
    expect(out.length).toBeLessThanOrEqual(PROJECT_CONTEXT_BUDGET);
    expect(out.length).toBeGreaterThan(PROJECT_CONTEXT_BUDGET * 0.6);
    expect(text.startsWith(out)).toBe(true);
    expect(out.endsWith(line)).toBe(true);
  });

  test("without line breaks it cuts after a sentence", () => {
    const sentence = "Residents talk about the heat network at twelve tables. ";
    const text = sentence.repeat(200);
    const out = cutAtBoundary(text, 1000);
    expect(out.length).toBeLessThanOrEqual(1000);
    expect(out.endsWith("tables.")).toBe(true);
  });

  test("without sentences it cuts at a space, never in a word", () => {
    const text = "word ".repeat(1000);
    const out = cutAtBoundary(text, 1003);
    expect(out.length).toBeLessThanOrEqual(1003);
    expect(out.endsWith("word")).toBe(true);
  });

  test("one unbroken run is cut at the budget, never in a surrogate pair", () => {
    expect(cutAtBoundary("a".repeat(50), 10)).toBe("a".repeat(10));
    const emoji = "🎉".repeat(20); // two code units each
    const out = cutAtBoundary(emoji, 11);
    expect(out).toBe("🎉".repeat(5));
  });

  test("a boundary too early in the text is not used", () => {
    const text = `Short intro.\n${"a".repeat(900)} ${"b".repeat(500)}`;
    const out = cutAtBoundary(text, 1000);
    // The line break at 12 would keep almost nothing; the space at 913 is used instead.
    expect(out).toBe(`Short intro.\n${"a".repeat(900)}`);
  });
});

/**
 * Every place in the platform's sources that reads a project's `context` into something a
 * model reads goes through contextForPrompt. This fails when new code reads the column
 * directly, the way a lint rule would: the pattern finds `project.context`, `p.context`,
 * `row.context` and the like, and each hit must call the helper on the same line or be
 * listed here with why it is not a prompt.
 */
const ALLOWED: readonly { file: string; includes: string; why: string }[] = [
  { file: "account/src/jobs.ts", includes: "p.context", why: "an email job's log line" },
  {
    file: "agentic/src/runs/context.ts",
    includes: "row?.context",
    why: "the workspace's context, not the project's",
  },
  { file: "analysis/src/store.ts", includes: "row.context", why: "an analysis run's own context" },
  { file: "feedback/src/responses.ts", includes: "r.row.context", why: "a feedback response" },
  {
    file: "map/src/groups.ts",
    includes: "prepared.context",
    why: "MapStore.projectContext already applies the budget",
  },
  {
    file: "map/src/factcheck.ts",
    includes: "prepared.context",
    why: "MapStore.projectContext already applies the budget",
  },
  { file: "samples/src/best-practices.ts", includes: "project.context", why: "seeds the column" },
  { file: "samples/src/millbrook.ts", includes: "project.context", why: "seeds the column" },
  {
    file: "staff/src/privacy-storage.ts",
    includes: "project.context",
    why: "the privacy export carries the stored text whole",
  },
  { file: "core/src/project-context.ts", includes: "project.context", why: "the helper's doc" },
  {
    // Not a prompt: get_project and update_project hand the stored text to an outside agent,
    // which may write it back. Cut to the prompt budget, a write-back would lose the rest.
    file: "agent-access/src/tools.ts",
    includes: "context: s(row.context)",
    why: "data returned to an agent, not a prompt; returned whole so a write-back keeps it",
  },
  {
    file: "verify/src/try-it/service.ts",
    includes: "context: project.context",
    why: "hands the stored text to replyPrompt, which budgets it with contextForPrompt",
  },
];

const PATTERN = /\b(?:project|p|row|prepared|proj)\??\.context\b/;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.tsx?$/.test(name) && !/\.(test|generated)\.ts$/.test(name)) out.push(full);
  }
  return out;
}

test("no prompt builder reads project.context without the budget", () => {
  const packages = path.resolve(import.meta.dir, "../..");
  const hits: string[] = [];
  for (const pkg of readdirSync(packages)) {
    const src = path.join(packages, pkg, "src");
    try {
      if (!statSync(src).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of sources(src)) {
      const rel = path.relative(packages, file);
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (!PATTERN.test(line) || line.includes("contextForPrompt(")) return;
          if (ALLOWED.some((a) => a.file === rel && line.includes(a.includes))) return;
          hits.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
  }
  expect(hits).toEqual([]);
});

test("the call sites that build prompts use the helper", () => {
  const packages = path.resolve(import.meta.dir, "../..");
  const sites = [
    "agentic/src/runs/context.ts",
    "agentic/src/runs/service.ts",
    "canvas/src/gather.ts",
    "canvas/src/ticks.ts",
    "chats/src/prompt.ts",
    "chats/src/summaries.ts",
    "conversations/src/v1/reply.ts",
    "conversations/src/v1/summary.ts",
    "map/src/store.ts",
    "reports/src/summarize.ts",
    "verify/src/service.ts",
  ];
  for (const site of sites)
    expect(readFileSync(path.join(packages, site), "utf8")).toContain("contextForPrompt(");
});
