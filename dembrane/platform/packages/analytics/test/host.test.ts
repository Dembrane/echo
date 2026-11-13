import { describe, expect, test } from "bun:test";
import { hostDistinctId } from "../src";

describe("hostDistinctId", () => {
  test("is the email, trimmed and lowercased, as the browser identifies", () => {
    expect(hostDistinctId("  Ana@Example.NL ", "d-1")).toBe("ana@example.nl");
  });

  test("falls back to the Directus user id the browser aliases", () => {
    expect(hostDistinctId(null, "d-1")).toBe("d-1");
    expect(hostDistinctId("  ", "d-1")).toBe("d-1");
  });
});
