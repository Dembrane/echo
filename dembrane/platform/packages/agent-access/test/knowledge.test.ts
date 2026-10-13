import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@dembrane/observability";
import { docsCorpus, NO_DOCS } from "../src/knowledge";
import { readDoc, searchDocs, type ToolDeps } from "../src/tools";

const depsFor = (docsDir: string) =>
  ({ docs: docsCorpus({ docsBaseUrl: "", logger: {} as Logger, docsDir }) }) as unknown as ToolDeps;

// The images carry no docs folder: every docs tool answers empty and says why.
test("without a docs corpus the docs tools answer empty with a note", async () => {
  const d = depsFor(join(tmpdir(), "no-docs-folder-here"));
  expect(await searchDocs(d, null, 50)).toEqual({ pattern: null, results: [], note: NO_DOCS });
  expect(await searchDocs(d, "consent", 3)).toEqual({
    pattern: "consent",
    results: [],
    note: NO_DOCS,
  });
  expect(await readDoc(d, "index.md", 1, 400)).toEqual({ path: "index.md", text: NO_DOCS });
});

test("from source the docs tools read the published pages of the docs folder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "docs-"));
  mkdirSync(join(dir, "users"));
  mkdirSync(join(dir, "_authoring"));
  writeFileSync(join(dir, "index.md"), "# Home\n\nAsk for consent first.\n");
  writeFileSync(join(dir, "users", "host.md"), "# Hosts\n");
  // Not pages of the site: a translation twin and an authoring note.
  writeFileSync(join(dir, "index.nl-NL.md"), "# Thuis\n\nVraag eerst om consent.\n");
  writeFileSync(join(dir, "_authoring", "STYLE.md"), "# Style\n\nconsent\n");
  const d = depsFor(dir);

  expect(await searchDocs(d, null, 50)).toEqual({
    pattern: null,
    results: [
      { path: "index.md", title: "Home", line: null, text: null },
      { path: "users/host.md", title: "Hosts", line: null, text: null },
    ],
  });
  expect(await searchDocs(d, "consent", 3)).toMatchObject({
    pattern: "consent",
    results: [{ path: "index.md", title: "Home", line: 3, text: "Ask for consent first." }],
  });
  expect(await readDoc(d, "users/host.md", 1, 400)).toEqual({
    path: "users/host.md",
    text: "1: # Hosts",
  });
});
