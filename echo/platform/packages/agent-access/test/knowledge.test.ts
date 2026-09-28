import { expect, test } from "bun:test";
import type { Logger } from "@dembrane/observability";
import { docsCorpus, NO_DOCS } from "../src/knowledge";
import { readDoc, searchDocs, type ToolDeps } from "../src/tools";

// No docs folder in the repository: every docs tool answers empty and says why.
test("without a docs corpus the docs tools answer empty with a note", async () => {
  const docs = docsCorpus({ docsBaseUrl: "", logger: {} as Logger });
  const d = { docs } as unknown as ToolDeps;
  expect(await searchDocs(d, null, 50)).toEqual({ pattern: null, results: [], note: NO_DOCS });
  expect(await searchDocs(d, "consent", 3)).toEqual({
    pattern: "consent",
    results: [],
    note: NO_DOCS,
  });
  expect(await readDoc(d, "index.md", 1, 400)).toEqual({ path: "index.md", text: NO_DOCS });
});
