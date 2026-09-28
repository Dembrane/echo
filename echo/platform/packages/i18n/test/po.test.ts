import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FakeCompleter } from "@dembrane/llm";
import { fillCatalog, placeholdersOf } from "../src/fill";
import { fillEntry, missingEntries, parsePo, serializePo } from "../src/po";

const HEADER = `msgid ""
msgstr ""
"Language: nl-NL\\n"
"X-Generator: @lingui/cli\\n"`;

const nl = `${HEADER}

#. js-lingui-explicit-id
#: src/lib/errors/messages/project.ts:6
msgid "error.project.not_found"
msgstr ""

#: src/routes/Home.tsx:3
msgid "Hello {name}"
msgstr "Hallo {name}"

#, fuzzy
#: src/routes/Home.tsx:4
msgid "Machine done"
msgstr "Machine klaar"

#: src/routes/Home.tsx:5
msgid "Go <0>home</0>"
msgstr ""

#~ msgid "Old"
#~ msgstr ""
`;

const en = `${HEADER.replace("nl-NL", "en-US")}

#. js-lingui-explicit-id
msgid "error.project.not_found"
msgstr "We could not find this project."

msgid "Hello {name}"
msgstr "Hello {name}"

msgid "Machine done"
msgstr "Machine done"

msgid "Go <0>home</0>"
msgstr "Go <0>home</0>"
`;

test("an untouched catalog is written back byte for byte", () => {
  expect(serializePo(parsePo(nl))).toBe(nl);
});

test("only empty, live entries are owed; filling flags them fuzzy", () => {
  const po = parsePo(nl);
  const owed = missingEntries(po);
  expect(owed.map((e) => e.msgid)).toEqual(["error.project.not_found", "Go <0>home</0>"]);
  fillEntry(owed[0]!, 'We konden dit "project" niet vinden.');
  const text = serializePo(po);
  expect(text).toContain(
    '#. js-lingui-explicit-id\n#: src/lib/errors/messages/project.ts:6\n#, fuzzy\nmsgid "error.project.not_found"\nmsgstr "We konden dit \\"project\\" niet vinden."',
  );
  expect(parsePo(text).entries.find((e) => e.msgid === "error.project.not_found")?.flags).toEqual(
    new Set(["fuzzy"]),
  );
});

test("placeholders and tags must survive translation", () => {
  expect(placeholdersOf("Go <0>home</0>, {name}")).toBe(
    placeholdersOf("Ga {name} <0>naar huis</0>"),
  );
  expect(placeholdersOf("{count, plural, one {# item} other {# items}}")).toBe("{count");
  expect(placeholdersOf("Hi {name}")).not.toBe(placeholdersOf("Hoi {naam}"));
});

test("fillCatalog fills from the source texts, keeps reviewed ones, drops broken placeholders", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "i18n-"));
  writeFileSync(path.join(dir, "en-US.po"), en);
  writeFileSync(path.join(dir, "nl-NL.po"), nl);
  const fake = new FakeCompleter().on("dembrane", (r) => {
    const payload = JSON.parse(r.user as string) as {
      target: string;
      glossary: { register: string };
      texts: { i: number; text: string; note?: string }[];
    };
    expect(payload.target).toBe("Dutch");
    expect(payload.glossary.register).toContain("je");
    return JSON.stringify({
      translations: payload.texts.map((t) => ({
        i: t.i,
        // The tag answer loses its tag, so it is rejected.
        text: t.text.includes("<0>") ? "Ga naar huis" : "We konden dit project niet vinden.",
      })),
    });
  });
  const [report] = await fillCatalog(dir, fake);
  expect(report).toMatchObject({ locale: "nl-NL", missing: 2, filled: 1, rejected: 1 });
  const after = readFileSync(path.join(dir, "nl-NL.po"), "utf8");
  expect(after).toContain('msgstr "We konden dit project niet vinden."');
  expect(after).toContain('msgid "Machine done"\nmsgstr "Machine klaar"');
  expect(after).toContain('msgid "Go <0>home</0>"\nmsgstr ""');
  // Without a completer it only counts.
  const [counted] = await fillCatalog(dir, null);
  expect(counted).toMatchObject({ missing: 1, filled: 0 });
});
