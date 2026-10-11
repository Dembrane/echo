import { describe, expect, test } from "bun:test";
import { renderPrompt, templateVersion } from "../src";
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

describe("templateVersion", () => {
  test("is a stable 12-digit hash, shared with the English fallback", () => {
    const en = templateVersion("generate_artifact", "en");
    expect(en).toMatch(/^[0-9a-f]{12}$/);
    expect(templateVersion("generate_artifact", "en")).toBe(en);
    expect(templateVersion("generate_artifact", "xx")).toBe(en);
  });

  test("differs between templates", () => {
    expect(templateVersion("summary", "en")).not.toBe(templateVersion("summary", "nl"));
  });
});
