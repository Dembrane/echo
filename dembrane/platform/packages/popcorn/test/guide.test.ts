import { expect, test } from "bun:test";
import { buildBundle } from "../src/bundle";
import { defaultSettings, normalizeSettings } from "../src/settings";

const project = {
  id: "6b3a1c00-0003-4003-8003-000000000003",
  is_conversation_allowed: true,
  language: "nl",
};
const session = (guide: unknown, extra = {}) =>
  (
    buildBundle({
      state: {},
      settings: normalizeSettings({ ...defaultSettings("Town hall"), guide }, "Town hall"),
      report: {},
      project: { ...project, ...extra },
      participantBaseUrl: "https://portal.example/",
    }).files as Record<string, Record<string, unknown>>
  )["session.json"] as Record<string, unknown>;

test("the host guide screen carries its steps and the code to take part", () => {
  const guide = session({
    enabled: true,
    title: "Hoe neem je op",
    steps: "Scan de QR-code\n\n  Druk op Opnemen  \n",
  }).guide as { title: string; steps: string[]; qr: { url: string; svg: string } };
  expect(guide.title).toBe("Hoe neem je op");
  expect(guide.steps).toEqual(["Scan de QR-code", "Druk op Opnemen"]);
  expect(guide.qr.url).toBe(
    `https://portal.example/nl-NL/${project.id}/start?utm_source=popcorn_qr`,
  );
  expect(guide.qr.svg).toContain("<svg");
});

test("no screen when it is off, has no steps, or nobody can take part", () => {
  expect(session({ enabled: false, title: "x", steps: "a" }).guide).toBeUndefined();
  expect(session({ enabled: true, title: "x", steps: " \n " }).guide).toBeUndefined();
  expect(
    session({ enabled: true, title: "x", steps: "a" }, { is_conversation_allowed: false }).guide,
  ).toBeUndefined();
});
