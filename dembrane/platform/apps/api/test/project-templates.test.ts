import { expect, test } from "bun:test";
import { PROJECT_TEMPLATES } from "@dembrane/projects";
import { DEFAULT_LANGUAGES, DEFAULT_TOPICS } from "@dembrane/verify/defaults";

// The template registry (projects) names verify's built-in topics and the portal languages
// without importing verify; this keeps the two in step.
test("every topic a template selects is a built-in verification topic", () => {
  const keys = new Set(DEFAULT_TOPICS.map((t) => t.key));
  for (const t of PROJECT_TEMPLATES)
    for (const k of t.preset.verification_topics)
      expect([t.key, k, keys.has(k)]).toEqual([t.key, k, true]);
});

test("a template's participant texts cover every portal language", () => {
  const codes = DEFAULT_LANGUAGES.map((l) => l.code.slice(0, 2)).sort();
  for (const t of PROJECT_TEMPLATES)
    for (const text of [...t.preset.tags, ...(t.preset.name_label ? [t.preset.name_label] : [])])
      expect(Object.keys(text).sort()).toEqual(codes);
});
