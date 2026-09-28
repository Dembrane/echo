import { expect, test } from "bun:test";
import { BadRequestError, ValidationError } from "@dembrane/core";
import { effectiveLegalBasis, isExternalClient, legalWrite } from "../src/legal";
import { round2, safeForFilename } from "../src/projects";
import { parseSchedule, reportTitle } from "../src/reports";
import { unzip, zip } from "../src/zip";

const now = new Date("2026-09-27T12:00:00Z");

test("zip: what goes in comes back out, names and contents", () => {
  const enc = new TextEncoder();
  const files = [
    { name: "20260901_092000_Resident_1_c1000000-transcript.md", data: enc.encode("a\nb\n") },
    { name: "leeg.md", data: enc.encode("é\n") },
  ];
  const back = unzip(zip(files, now));
  expect(back.map((f) => f.name)).toEqual(files.map((f) => f.name));
  expect(back.map((f) => new TextDecoder().decode(f.data))).toEqual(["a\nb\n", "é\n"]);
});

test("transcript file names keep letters and digits and fold the rest into single underscores", () => {
  expect(safeForFilename("Resident 1 (north)", 50)).toBe("Resident_1_north");
  expect(safeForFilename("émile.o'brien", 30)).toBe("émile_o_brien");
  expect(safeForFilename("x".repeat(60), 50)).toHaveLength(50);
  expect(safeForFilename(null, 10)).toBe("");
});

test("report title is the first markdown heading", () => {
  expect(reportTitle("intro\n# City listening \n## sub")).toBe("City listening");
  expect(reportTitle("no heading")).toBeNull();
  expect(reportTitle(null)).toBeNull();
});

test("schedule: ISO forms Python accepted; naive is UTC; ten minutes lead", () => {
  expect(parseSchedule("2026-10-01T10:00:00Z", now).toISOString()).toBe("2026-10-01T10:00:00.000Z");
  expect(parseSchedule("2026-10-01T10:00:00+02:00", now).toISOString()).toBe(
    "2026-10-01T08:00:00.000Z",
  );
  expect(parseSchedule("2026-10-01 10:00", now).toISOString()).toBe("2026-10-01T10:00:00.000Z");
  expect(() => parseSchedule("next tuesday", now)).toThrow(ValidationError);
  expect(() => parseSchedule("2026-09-27T12:05:00Z", now)).toThrow(BadRequestError);
});

test("round2 is Python's round(x, 2)", () => {
  expect(round2(312.5 / 3600)).toBe(0.09);
  expect(round2(0.125)).toBe(0.12);
  expect(round2(0.375)).toBe(0.38);
  expect(round2(1.005)).toBe(1);
});

test("legal basis: first level with a basis wins, with its own link", () => {
  expect(
    effectiveLegalBasis({
      project: null,
      workspace: { legal_basis: "consent", privacy_policy_url: "https://w" },
      owner: { legal_basis: "client-managed" },
    }),
  ).toEqual({ legal_basis: "consent", privacy_policy_url: "https://w", source: "workspace" });
  expect(effectiveLegalBasis({}).source).toBe("default");
});

test("legal write: consent needs a valid link; other bases drop it; dembrane-events is checked only when new", () => {
  const base = { storedLegalBasis: null, storedPrivacyPolicyUrl: null };
  expect(
    legalWrite({ ...base, fieldsSet: new Set(["name"]), legalBasis: null, privacyPolicyUrl: null }),
  ).toBeNull();
  expect(() =>
    legalWrite({
      ...base,
      fieldsSet: new Set(["legal_basis"]),
      legalBasis: "consent",
      privacyPolicyUrl: null,
    }),
  ).toThrow("A privacy policy link is required for consent-based processing");
  expect(
    legalWrite({
      ...base,
      fieldsSet: new Set(["legal_basis", "privacy_policy_url"]),
      legalBasis: "client-managed",
      privacyPolicyUrl: "https://x",
    })?.payload,
  ).toEqual({ legal_basis: "client-managed", privacy_policy_url: null });
  expect(
    legalWrite({
      storedLegalBasis: "dembrane-events",
      storedPrivacyPolicyUrl: null,
      fieldsSet: new Set(["legal_basis"]),
      legalBasis: "dembrane-events",
      privacyPolicyUrl: null,
    })?.requiresDembraneEmail,
  ).toBe(false);
});

test("an external-client workspace is marked by usage context, a data owner, or a foreign biller", () => {
  expect(isExternalClient({ usage_context: "External" })).toBe(true);
  expect(isExternalClient({ usage_context: "internal", data_owner_email: "x@y" })).toBe(false);
  expect(isExternalClient({ data_owner_email: " x@y " })).toBe(true);
  expect(isExternalClient({ billed_to_team_id: "b", org_id: "a" })).toBe(true);
  expect(isExternalClient({ billed_to_team_id: "a", org_id: "a" })).toBe(false);
});
