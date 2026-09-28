import { expect, test } from "bun:test";
import { renderPrompt } from "../src";
import fixtures from "./jinja-fixtures.json";

// Rendered by Jinja2 from the Python API's prompt_templates with the Python API's environment.
test.each(fixtures.map((f) => [f.name, f] as const))("%s renders as Jinja did", (_n, f) => {
  const [name, lang] = f.name.split(".");
  expect(renderPrompt(name as string, lang as string, f.vars)).toBe(f.text);
});

test("an unknown language falls back to English", () => {
  expect(renderPrompt("generate_conversation_title", "xx", { summary: "s" })).toBe(
    renderPrompt("generate_conversation_title", "en", { summary: "s" }),
  );
});

test("an unknown template is refused", () => {
  expect(() => renderPrompt("nope", "en")).toThrow("not found and no default available");
});
