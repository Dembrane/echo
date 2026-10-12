import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { assetPath } from "@dembrane/core";
import { catalogEntries, LOCALES } from "@dembrane/i18n";
import { render, subjectOf } from "../src/emails";

const invite = {
  template: "account_invite",
  data: { org_name: "Acme", sign_in_url: "https://d/login?next=%2Fo%2F1" },
} as const;

test("an email in nl-NL is worded from the Dutch catalog", () => {
  expect(subjectOf(invite, "nl-NL")).toBe("Je dembrane-account voor Acme");
  const { html, text } = render(invite, "nl");
  expect(text).toStartWith(
    "We hebben Acme op dembrane voor je klaargezet. Log in met de code die we naar dit e-mailadres sturen: geen wachtwoord nodig.\n\nInloggen:\nhttps://d/login?next=%2Fo%2F1\n\n",
  );
  expect(text).toEndWith("\n\nHet dembrane-team");
  expect(html).toContain("Je account staat klaar.");
  expect(html).toContain("Inloggen");
});

test("a text the locale has not translated yet renders in English", () => {
  // Read what nl-NL holds today, so the test stays true once the translator fills it.
  const nl = catalogEntries(readFileSync(assetPath("i18n", "locales", "nl-NL.po"), "utf8"));
  const expected = nl.get("email.common.fallback") ?? "Or paste this into your browser:";
  expect(render(invite, "nl-NL").html).toContain(`${expected}<br>`);
});

test("English is the default and matches the old subject lines", () => {
  expect(subjectOf(invite)).toBe("Your dembrane account for Acme");
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

test("the report published email links the report and the unsubscribe page in the recipient's locale", () => {
  const published = {
    template: "report_published",
    data: {
      portal_url: "https://portal.example",
      project_id: "p1",
      token: "t-1",
      conversation_name: "Resident 1",
    },
  } as const;
  expect(subjectOf(published)).toBe("A report featuring your input is ready");
  const { html, text } = render(published, "nl");
  expect(html).toContain('Je rapport over "Resident 1" is klaar.');
  expect(html).toContain('href="https://portal.example/nl-NL/p1/report"');
  expect(html).toContain(
    'href="https://portal.example/nl-NL/p1/unsubscribe?token=t-1&amp;project_id=p1"',
  );
  expect(text).toContain("https://portal.example/nl-NL/p1/report");
  expect(text).toContain("https://portal.example/nl-NL/p1/unsubscribe?token=t-1&project_id=p1");

  const anonymous = { ...published, data: { ...published.data, conversation_name: "" } };
  expect(render(anonymous).html).toContain("Your report is ready.");
  expect(render(anonymous).html).toContain('href="https://portal.example/en-US/p1/report"');
});

test("the offer sent email names the organisation and the offer and links where it is signed, in English and Dutch", () => {
  const sent = {
    template: "account_offer_sent",
    data: {
      org_name: "Acme & Co",
      document_title: "Acme x dembrane",
      sign_url: "https://d/o/1/account/documents/2/sign",
    },
  } as const;
  expect(subjectOf(sent)).toBe("Your offer from dembrane is ready to sign");
  const en = render(sent);
  expect(en.text).toBe(
    "We sent Acme & Co an offer: Acme x dembrane. Read it and sign it in dembrane.\n\nRead and sign the offer:\nhttps://d/o/1/account/documents/2/sign\n\nThe dembrane team",
  );
  expect(en.html).toContain("Your offer from dembrane is ready to sign.");
  expect(en.html).toContain("We sent Acme &amp; Co an offer: ");
  expect(en.html).toContain(">Acme x dembrane</em>");
  expect(en.html).toContain('href="https://d/o/1/account/documents/2/sign"');
  expect(en.html).toContain("Read and sign the offer");
  expect(en.html).toContain("Or paste this into your browser:<br>");

  expect(subjectOf(sent, "nl-NL")).toBe("Je offerte van dembrane staat klaar om te ondertekenen");
  const nl = render(sent, "nl");
  expect(nl.text).toBe(
    "We hebben Acme & Co een offerte gestuurd: Acme x dembrane. Lees de offerte en onderteken hem in dembrane.\n\nOfferte lezen en ondertekenen:\nhttps://d/o/1/account/documents/2/sign\n\nHet dembrane-team",
  );
  expect(nl.html).toContain("Je offerte van dembrane staat klaar om te ondertekenen.");
  expect(nl.html).toContain("We hebben Acme &amp; Co een offerte gestuurd: ");
  expect(nl.html).toContain('href="https://d/o/1/account/documents/2/sign"');
  expect(nl.html).toContain("Offerte lezen en ondertekenen");
});

test("the offer sent email has its own words in every language", () => {
  const ids = ["subject", "heading", "body", "cta", "text_cta"].map(
    (k) => `email.account_offer_sent.${k}`,
  );
  const words = (locale: string) =>
    catalogEntries(readFileSync(assetPath("i18n", "locales", `${locale}.po`), "utf8"));
  const english = words("en-US");
  for (const locale of LOCALES.filter((l) => l !== "en-US"))
    for (const id of ids) {
      const text = words(locale).get(id);
      expect(text, `${locale} ${id}`).toBeTruthy();
      expect(text, `${locale} ${id}`).not.toBe(english.get(id));
    }
});
