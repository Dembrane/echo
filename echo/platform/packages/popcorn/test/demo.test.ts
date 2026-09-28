import { describe, expect, test } from "bun:test";
import { ForbiddenError } from "@dembrane/core";
import { chunkTimestamp, demoIdentity, refuseProduction } from "../src/demo";

describe("synthetic demo seed", () => {
  test("ids are the seed's uuid5 names", () => {
    // uuid5(NAMESPACE_URL, "dembrane:synthetic-demo:sales-portal:nl"), as seed_demo.py minted it.
    expect(demoIdentity("sales-portal", "nl")).toBe("6a6ef9f9-50c7-5e58-a7b4-84d314639029");
  });

  test("chunk times step twenty seconds in the start's own offset", () => {
    expect(chunkTimestamp("2026-10-28T12:40:00+01:00", 0)).toBe("2026-10-28T12:40:00+01:00");
    expect(chunkTimestamp("2026-10-28T23:59:50+01:00", 20)).toBe("2026-10-29T00:00:10+01:00");
    expect(chunkTimestamp("2026-10-28T12:40:00", 40)).toBe("2026-10-28T12:40:40");
    expect(chunkTimestamp("2026-10-28T12:40:00.5Z", 20)).toBe("2026-10-28T12:40:20.500000+00:00");
  });

  test("production hosts are refused, staging is not", () => {
    expect(() => refuseProduction(["https://api.dembrane.com"])).toThrow(ForbiddenError);
    expect(() => refuseProduction(["https://dashboard.dembrane.com/x"])).toThrow(ForbiddenError);
    expect(() =>
      refuseProduction(["https://api.echo-next.dembrane.com", "nonsense"]),
    ).not.toThrow();
  });
});
