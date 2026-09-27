import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { pyFloat, renderPrompt } from "../src/prompts/render";

const fixture: unknown = JSON.parse(
  readFileSync(new URL("./prompts.fixture.json", import.meta.url), "utf8"),
);

// Rendered by Jinja2 from the same templates (scratch script over echo/server/prompt_templates);
// the TypeScript renderer must produce the identical text.
describe("prompt templates render as Jinja2 did", () => {
  for (const c of fixture as {
    name: string;
    lang: string;
    vars: Record<string, unknown>;
    text: string;
  }[]) {
    test(`${c.name}.${c.lang}`, () => {
      const vars = { ...c.vars };
      if (Array.isArray(vars.conversations))
        vars.conversations = (vars.conversations as Record<string, unknown>[]).map((x) => ({
          ...x,
          duration: pyFloat(x.duration as number | null),
        }));
      expect(renderPrompt(c.name, c.lang, vars)).toBe(c.text);
    });
  }
  test("a language without its own template falls back to English", () => {
    expect(renderPrompt("context_project", "nl", { project_context: "x" })).toBe(
      renderPrompt("context_project", "en", { project_context: "x" }),
    );
  });
});
