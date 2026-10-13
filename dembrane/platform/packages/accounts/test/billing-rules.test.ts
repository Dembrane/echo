import { describe, expect, test } from "bun:test";
import {
  COUNTRY_CODES,
  checkBilling,
  cleanKbo,
  cleanKvk,
  cleanVat,
  countryCodeOf,
  countryGroup,
  countryName,
  EU_VAT,
  identified,
  kboFits,
  kvkFits,
  peppolFits,
  vatFits,
} from "../src/billing-rules";

const problems = (a: Parameters<typeof checkBilling>[0]) =>
  checkBilling(a).problems.map((p) => `${p.field}: ${p.kind}`);

describe("the country", () => {
  test("every ISO code once, each with a name", () => {
    expect(COUNTRY_CODES).toHaveLength(249);
    expect(new Set(COUNTRY_CODES).size).toBe(249);
    for (const code of COUNTRY_CODES) expect(countryName(code)).not.toBe(code);
  });

  test("decides the group: the Netherlands, Belgium, the rest of the EU, everywhere else", () => {
    expect(countryGroup("NL")).toBe("nl");
    expect(countryGroup("BE")).toBe("be");
    expect(Object.keys(EU_VAT)).toHaveLength(27);
    for (const code of Object.keys(EU_VAT))
      expect(countryGroup(code)).toBe(code === "NL" ? "nl" : code === "BE" ? "be" : "eu");
    for (const code of ["GB", "US", "CH", "NO"]) expect(countryGroup(code)).toBe("other");
    for (const none of [null, undefined, "", "XX", "nl", "Netherlands"])
      expect(countryGroup(none)).toBeNull();
  });

  test("is read from a code or from its name in a language the product ships", () => {
    expect(countryCodeOf("nl")).toBe("NL");
    for (const name of ["Netherlands", "Nederland", "the Netherlands", " niederlande ", "Pays-Bas"])
      expect(countryCodeOf(name)).toBe("NL");
    expect(countryCodeOf("België")).toBe("BE");
    expect(countryCodeOf("Deutschland")).toBe("DE");
    expect(countryCodeOf("UK")).toBe("GB");
    for (const none of ["Atlantis", "", "  ", null, undefined])
      expect(countryCodeOf(none)).toBeNull();
  });
});

describe("numbers", () => {
  test("each EU country's own example fits its own rule, and no other prefix does", () => {
    for (const [code, rule] of Object.entries(EU_VAT)) {
      expect(vatFits(code, rule.example)).toBe(true);
      expect(cleanVat(code, rule.example)).toBe(rule.example);
      expect(vatFits(code, `XX${rule.example.slice(2)}`)).toBe(false);
    }
  });

  test("a VAT number is cleaned: no spaces, dots or dashes, capitals, the prefix in front", () => {
    expect(cleanVat("NL", " nl 1234.56.789 b01 ")).toBe("NL123456789B01");
    expect(cleanVat("NL", "123456789B01")).toBe("NL123456789B01");
    expect(cleanVat("BE", "0123.456.789")).toBe("BE0123456789");
    expect(cleanVat("DE", "123 456 789")).toBe("DE123456789");
    expect(cleanVat("AT", "u12345678")).toBe("ATU12345678");
    // Greece's country code is GR; its VAT numbers start with EL.
    expect(cleanVat("GR", "GR123456789")).toBe("EL123456789");
    expect(cleanVat("GR", "123456789")).toBe("EL123456789");
    // Outside the EU there is no format to clean to.
    expect(cleanVat("GB", " GB 123 4567 89 ")).toBe("GB 123 4567 89");
    expect(cleanVat("NL", "")).toBe("");
  });

  test("a VAT number that cannot be right for the country does not fit", () => {
    expect(vatFits("NL", "NL12345678B01")).toBe(false);
    expect(vatFits("NL", "NL123456789A01")).toBe(false);
    expect(vatFits("NL", "DE123456789")).toBe(false);
    expect(vatFits("BE", "BE2123456789")).toBe(false);
    expect(vatFits("BE", "BE1123456789")).toBe(true);
    expect(vatFits("DE", "DE12345678")).toBe(false);
    expect(vatFits("FR", "FRO1123456789")).toBe(false);
    expect(vatFits("US", "anything at all")).toBe(true);
  });

  test("a KvK number is 8 digits; a KBO number is 10, starting with 0 or 1", () => {
    expect(cleanKvk(" 1234 5678 ")).toBe("12345678");
    expect(kvkFits("12345678")).toBe(true);
    expect(kvkFits("1234567")).toBe(false);
    expect(kvkFits(cleanKvk("KvK 12345678"))).toBe(false);
    expect(cleanKbo("0123456789")).toBe("0123.456.789");
    expect(cleanKbo("BE 0123.456.789")).toBe("0123.456.789");
    expect(kboFits("0123.456.789")).toBe(true);
    expect(kboFits("1123.456.789")).toBe(true);
    expect(kboFits("2123.456.789")).toBe(false);
    expect(kboFits(cleanKbo("123456789"))).toBe(false);
  });

  test("a Peppol ID is a scheme of four digits, a colon and the number", () => {
    for (const id of ["0106:12345678", "0190:00000000000000000000", "9925:BE0123456789"])
      expect(peppolFits(id)).toBe(true);
    for (const id of ["12345678", "106:12345678", "0106:", "0106:12 34", "iso6523::0106:1"])
      expect(peppolFits(id)).toBe(false);
  });
});

describe("what each country is asked", () => {
  test("no country: that is the one thing to fix", () => {
    expect(problems({})).toEqual(["country_code: missing"]);
    expect(problems({ country_code: "Atlantis" })).toEqual(["country_code: missing"]);
  });

  test("the Netherlands: a KvK number or a VAT number, either is enough", () => {
    expect(problems({ country_code: "NL" })).toEqual(["kvk_number: missing", "vat_id: missing"]);
    expect(problems({ country_code: "NL", kvk_number: "12345678" })).toEqual([]);
    expect(problems({ country_code: "NL", vat_id: "nl123456789b01" })).toEqual([]);
    expect(problems({ country_code: "NL", kvk_number: "1234", vat_id: "NL12" })).toEqual([
      "vat_id: format",
      "kvk_number: format",
    ]);
    // The VAT question is not asked there, so nothing is recorded about it.
    const { clean } = checkBilling({
      country_code: "NL",
      kvk_number: "12345678",
      no_vat_number: true,
    });
    expect(clean).toMatchObject({ kvk_number: "12345678", vat_id: null, no_vat_number: null });
  });

  test("Belgium: a VAT number, or the statement that there is none and the KBO number", () => {
    expect(problems({ country_code: "BE" })).toEqual(["vat_id: missing"]);
    expect(problems({ country_code: "BE", vat_id: "0123.456.789" })).toEqual([]);
    expect(problems({ country_code: "BE", no_vat_number: true })).toEqual(["kbo_number: missing"]);
    const { problems: none, clean } = checkBilling({
      country_code: "BE",
      no_vat_number: true,
      kbo_number: "0123456789",
    });
    expect(none).toEqual([]);
    expect(clean).toMatchObject({ vat_id: null, no_vat_number: true, kbo_number: "0123.456.789" });
    expect(checkBilling({ country_code: "BE", vat_id: "BE0123456789" }).clean.no_vat_number).toBe(
      false,
    );
  });

  test("another EU country: a VAT number in its own format, or the statement that there is none", () => {
    expect(problems({ country_code: "DE" })).toEqual(["vat_id: missing"]);
    expect(problems({ country_code: "DE", vat_id: "DE12" })).toEqual(["vat_id: format"]);
    expect(problems({ country_code: "DE", vat_id: "NL123456789B01" })).toEqual(["vat_id: format"]);
    expect(problems({ country_code: "DE", no_vat_number: true })).toEqual([]);
    // Saying there is none and giving one is a contradiction, not a choice we make for them.
    expect(problems({ country_code: "DE", no_vat_number: true, vat_id: "DE123456789" })).toEqual([
      "no_vat_number: format",
    ]);
  });

  test("outside the EU: nothing is asked, and a number that is given is kept as typed", () => {
    expect(problems({ country_code: "US" })).toEqual([]);
    const { clean } = checkBilling({
      country_code: "GB",
      vat_id: "GB 123 4567 89",
      no_vat_number: true,
    });
    expect(clean).toMatchObject({ vat_id: "GB 123 4567 89", no_vat_number: null });
  });

  test("a portal needs its name, and the name is kept only for a portal", () => {
    const nl = { country_code: "NL", kvk_number: "12345678" };
    expect(problems({ ...nl, invoice_delivery: "portal" })).toEqual(["invoice_portal: missing"]);
    expect(
      checkBilling({ ...nl, invoice_delivery: "portal", invoice_portal: " Example portal " }).clean
        .invoice_portal,
    ).toBe("Example portal");
    expect(
      checkBilling({ ...nl, invoice_delivery: "email", invoice_portal: "Example portal" }).clean
        .invoice_portal,
    ).toBeNull();
    expect(problems({ ...nl, peppol_id: "12345678" })).toEqual(["peppol_id: format"]);
  });
});

describe("stored details", () => {
  const row = {
    country_code: null,
    country: null,
    vat_id: null,
    no_vat_number: null,
    kvk_number: null,
    kbo_number: null,
  };

  test("name the customer by a number, by having no VAT number, or by being outside the EU", () => {
    expect(identified(row)).toBe(false);
    expect(identified({ ...row, country_code: "DE" })).toBe(false);
    expect(identified({ ...row, country_code: "DE", no_vat_number: true })).toBe(true);
    expect(identified({ ...row, country_code: "NL", kvk_number: "12345678" })).toBe(true);
    expect(identified({ ...row, country_code: "US" })).toBe(true);
  });

  test("saved before the country was a code: judged by the name and the numbers", () => {
    expect(identified({ ...row, country: "Nederland" })).toBe(false);
    expect(identified({ ...row, country: "Nederland", vat_id: "NL001234567B01" })).toBe(true);
    expect(identified({ ...row, country: "United States" })).toBe(true);
    expect(identified({ ...row, country: "Atlantis" })).toBe(false);
  });
});
