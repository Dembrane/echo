import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { assetPath, missingAssets } from "@echo/core";
import { API_ASSETS } from "../src/assets";

test("every file the API's boot check requires is in the source tree", () => {
  expect(missingAssets(API_ASSETS)).toEqual([]);
});

test("the boot check covers every script the popcorn page inlines", () => {
  const html = readFileSync(assetPath("popcorn", "static", "index.html"), "utf8");
  const scripts = [...html.matchAll(/<script src="assets\/([^"?]+)/g)].map((m) => m[1]);
  expect(scripts.length).toBeGreaterThan(0);
  for (const name of scripts) expect(API_ASSETS).toContain(`popcorn/static/${name}`);
});
