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
    "Je account staat klaar\n\nWe hebben Acme op dembrane gezet, met een demo die we voor jullie organisatie hebben gemaakt.\n\n",
  );
  expect(text).toContain("Inloggen:\nhttps://d/login?next=%2Fo%2F1\n\n");
  expect(text).toEndWith("\n\nHet dembrane-team\n");
  expect(html).toContain('<html lang="nl-NL">');
  expect(html).toContain("Je account staat klaar");
  expect(html).toContain("Inloggen");
});

test("a text the locale has not translated yet renders in English", () => {
  // Read what nl-NL holds today, so the test stays true once the translator fills it.
  const nl = catalogEntries(readFileSync(assetPath("i18n", "locales", "nl-NL.po"), "utf8"));
  const expected = nl.get("email.common.fallback") ?? "Or open this link:";
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
  expect(html).toContain("Je rapport over &#34;Resident 1&#34; is klaar.");
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
    "Your offer is ready to sign\n\nWe've prepared an offer for Acme & Co. Read it through, and sign it online when you're ready.\n\nOffer: Acme x dembrane\n\nSomeone else signs for Acme & Co? Open the offer and name them there; they get their own link.\n\nRead and sign the offer:\nhttps://d/o/1/account/documents/2/sign\n\nThe dembrane team\n",
  );
  expect(en.html).toContain("We've prepared an offer for Acme &amp; Co.");
  expect(en.html).toContain(">Acme x dembrane</td>");
  expect(en.html).toContain('href="https://d/o/1/account/documents/2/sign"');
  expect(en.html).toContain("Read and sign the offer");
  expect(en.html).toContain("Or open this link:<br>");
  // Without a manager, the team signs and nobody is offered as a reply address.
  expect(en.html).not.toContain("Reply to this email");

  expect(subjectOf(sent, "nl-NL")).toBe("Je offerte van dembrane staat klaar om te ondertekenen");
  const nl = render(sent, "nl");
  expect(nl.text).toStartWith(
    "Je offerte staat klaar om te ondertekenen\n\nWe hebben een offerte voor Acme & Co klaargezet.",
  );
  expect(nl.text).toEndWith("\n\nHet dembrane-team\n");
  expect(nl.html).toContain('href="https://d/o/1/account/documents/2/sign"');
  expect(nl.html).toContain("Offerte lezen en ondertekenen");
});

test("the offer sent email shows the offer's facts in the reader's language and is signed by the manager", () => {
  const sent = {
    template: "account_offer_sent",
    data: {
      org_name: "Gemeente Utrecht",
      document_title: "Gemeente Utrecht x dembrane",
      sign_url: "https://d/sign",
      reference: "OFF-2026-014",
      total_cents: "1210000",
      currency: "EUR",
      valid_until: "2026-12-01",
      manager_name: "Anna de Vries",
    },
  } as const;
  const en = render(sent);
  expect(en.text).toContain(
    "Offer: Gemeente Utrecht x dembrane\nReference: OFF-2026-014\nValid until: 1 December 2026\nTotal incl. VAT: €12,100.00",
  );
  expect(en.text).toContain(
    "Questions about it? Reply to this email and it reaches Anna de Vries.",
  );
  expect(en.text).toEndWith("Anna de Vries\ndembrane\n");
  const nl = render(sent, "nl-NL");
  expect(nl.text).toContain("Geldig tot: 1 december 2026");
  expect(nl.text).toMatch(/Totaal incl\. btw: €\s?12\.100,00/);
});

test("the signer invite says who asked, for which organisation, and what to do if it is the wrong person", () => {
  const ask = {
    template: "account_signer_invite",
    data: {
      inviter_name: "Bram <B>",
      org_name: "Acme",
      document_title: "Acme x dembrane",
      sign_url: "https://d/sign",
    },
  } as const;
  expect(subjectOf(ask)).toBe("Bram <B> asked you to sign Acme x dembrane");
  const { html, text } = render(ask);
  expect(html).toContain("Bram &lt;B&gt; named you as the person who signs");
  expect(html).not.toContain("<B>");
  expect(text).toContain("Not the right person to sign? Let Bram <B> know");
});

test("the sign-in code stands on its own line", () => {
  const { html, text } = render({ template: "sign_in_code", data: { code: "482913" } });
  expect(html).toContain("letter-spacing:0.12em");
  expect(html).toContain(">482913</p>");
  expect(text).toContain("482913");
});

test("the offer sent email has its own words in every language", () => {
  const ids = ["subject", "preview", "heading", "body", "signer", "cta", "text_cta"].map(
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
