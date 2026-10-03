import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { assetPath } from "@dembrane/core";
import { catalogEntries } from "@dembrane/i18n";
import { render, subjectOf } from "../src/emails";

const reminder = {
  template: "account_task_reminder",
  data: { org_name: "Acme", task_title: "Factuurgegevens", task_url: "https://d/o/1/account" },
} as const;

test("an email in nl-NL is worded from the Dutch catalog", () => {
  expect(subjectOf(reminder, "nl-NL")).toBe("Nog open: Factuurgegevens");
  const { html, text } = render(reminder, "nl");
  expect(text).toBe(
    "Factuurgegevens staat nog open voor Acme op dembrane. Het kost een minuut, en het houdt de zaken bij ons in beweging.\n\nOpen de stap:\nhttps://d/o/1/account\n\nHet dembrane-team",
  );
  expect(html).toContain("Er staat nog een stap open.");
  expect(html).toContain("Open de stap");
});

test("a text the locale has not translated yet renders in English", () => {
  // Read what nl-NL holds today, so the test stays true once the translator fills it.
  const nl = catalogEntries(readFileSync(assetPath("i18n", "locales", "nl-NL.po"), "utf8"));
  const expected = nl.get("email.common.fallback") ?? "Or paste this into your browser:";
  expect(render(reminder, "nl-NL").html).toContain(`${expected}<br>`);
});

test("English is the default and matches the old subject lines", () => {
  expect(subjectOf(reminder)).toBe("Still open: Factuurgegevens");
  expect(
    subjectOf({
      template: "org_invite",
      data: { inviter_name: "Ann", org_name: "Org", role: "admin", invite_url: "u" },
    }),
  ).toBe("Ann invited you to Org on dembrane");
  expect(subjectOf({ template: "plain", data: { text: "x" } })).toBeNull();
});

test("the password reset email carries the link and speaks the recipient's language", () => {
  const reset = {
    template: "reset_password",
    data: { reset_url: "https://d/password-reset?token=abc&x=1" },
  } as const;
  expect(subjectOf(reset)).toBe("Reset your dembrane password");
  const { html, text } = render(reset);
  expect(html).toContain('href="https://d/password-reset?token=abc&amp;x=1"');
  expect(text).toContain("https://d/password-reset?token=abc&x=1");
  expect(subjectOf(reset, "nl-NL")).toBe("Stel je dembrane-wachtwoord opnieuw in");
});
