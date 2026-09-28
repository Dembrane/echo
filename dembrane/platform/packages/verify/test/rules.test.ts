import { expect, test } from "bun:test";
import { slugify } from "../src";
import { pyIsoformat } from "../src/service";

test("slugify matches the Python helper", () => {
  expect(slugify("Local Needs!")).toBe("local-needs");
  expect(slugify("  Été _ à  --  Paris ")).toBe("été-à-paris");
  expect(slugify("!!!")).toBe("custom");
  expect(slugify("x".repeat(80))).toHaveLength(60);
});

test("timestamps in prompts read as Python's isoformat printed them", () => {
  expect(pyIsoformat("2026-09-01T09:40:00.000Z")).toBe("2026-09-01T09:40:00+00:00");
  expect(pyIsoformat("2026-09-01 09:40:00.906+00")).toBe("2026-09-01T09:40:00.906000+00:00");
  expect(pyIsoformat(null)).toBe("unknown");
});
