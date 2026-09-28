import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { assetPath } from "@dembrane/core";
import {
  catalogEntries,
  createMessages,
  I18N_ASSETS,
  LOCALES,
  message,
  resolveLocale,
  translator,
} from "../src";

const po = (lang: string, entries: Record<string, string>) =>
  `msgid ""\nmsgstr ""\n"Language: ${lang}\\n"\n\n${Object.entries(entries)
    .map(([id, text]) => `#. js-lingui-explicit-id\nmsgid "${id}"\nmsgstr "${text}"`)
    .join("\n\n")}\n`;

test("stored language values resolve to one of the eight locales, English otherwise", () => {
  expect(resolveLocale("nl")).toBe("nl-NL");
  expect(resolveLocale("nl-NL")).toBe("nl-NL");
  expect(resolveLocale("NL_nl")).toBe("nl-NL");
  expect(resolveLocale("de-AT")).toBe("de-DE");
  expect(resolveLocale("uk")).toBe("uk-UA");
  expect(resolveLocale("en-GB")).toBe("en-US");
  expect(resolveLocale("pt-BR")).toBe("en-US");
  expect(resolveLocale("")).toBe("en-US");
  expect(resolveLocale(null)).toBe("en-US");
});

test("a missing translation falls back to English and placeholders are filled", () => {
  const catalogs: Record<string, string> = {
    "en-US": po("en-US", { hello: "Hello {name}", bye: "Bye" }),
    "nl-NL": po("nl-NL", { hello: "Hallo {name}", bye: "" }),
  };
  const m = createMessages((l) => catalogs[l] ?? po(l, {}));
  expect(m("nl-NL", "hello", { name: "Ann" })).toBe("Hallo Ann");
  expect(m("nl-NL", "bye")).toBe("Bye");
  expect(m("de-DE", "hello", { name: "Ann" })).toBe("Hello Ann");
  // A param nobody passed keeps its placeholder, so the gap shows.
  expect(m("en-US", "hello")).toBe("Hello {name}");
  expect(() => m("en-US", "nope")).toThrow('no server message "nope"');
});

test("the shipped catalogs: every locale has a file, and every id has English", () => {
  const en = catalogEntries(readFileSync(assetPath("i18n", "locales", "en-US.po"), "utf8"));
  expect(I18N_ASSETS).toHaveLength(LOCALES.length);
  for (const locale of LOCALES) {
    const text = readFileSync(assetPath("i18n", "locales", `${locale}.po`), "utf8");
    for (const id of catalogEntries(text).keys()) expect(en.has(id)).toBe(true);
    expect(text).not.toContain(String.fromCharCode(0x2014));
  }
  expect(message("nl-NL", "email.account_task_reminder.subject", { task_title: "X" })).toBe(
    "Nog open: X",
  );
  expect(translator("nl")("task.billing_details.title")).toBe("Factuurgegevens");
});
