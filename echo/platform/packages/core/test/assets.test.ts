import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Glob } from "bun";
import { assetPath, isCompiled, missingAssets } from "../src";

const PLATFORM = resolve(import.meta.dir, "..", "..", "..");

/**
 * A path built from a module's own location works from source and finds nothing inside a
 * compiled binary (`/$bunfs`), so it passes every test and 500s in the image. Runtime code
 * locates files through assetPath; only these files may use their own location.
 */
const ALLOWED: Record<string, string> = {
  "packages/core/src/assets.ts": "the helper itself",
  "packages/config/src/cli.ts": "dev CLI run from the source tree, not in any image",
  "packages/accounts/src/seed-cli.ts": "dev CLI reading echo/demos, not in any image",
};
const SELF_RELATIVE = /import\.meta\.(dir|dirname|url|path|filename)\b|__dirname|__filename/;

test("no runtime code locates a file relative to its own source", async () => {
  const offenders: string[] = [];
  for await (const file of new Glob("{apps,packages}/*/src/**/*.{ts,tsx}").scan(PLATFORM)) {
    if (file in ALLOWED) continue;
    const lines = (await Bun.file(join(PLATFORM, file)).text()).split("\n");
    lines.forEach((line, i) => {
      if (SELF_RELATIVE.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  expect(offenders).toEqual([]);
});

test("from source, assets resolve to the package's own folder and docs to the repository's", () => {
  expect(isCompiled()).toBe(false);
  expect(assetPath("popcorn", "static", "index.html")).toBe(
    join(PLATFORM, "packages", "popcorn", "static", "index.html"),
  );
  expect(assetPath("docs")).toBe(resolve(PLATFORM, "..", "..", "docs"));
  expect(existsSync(assetPath("docs", "README.md"))).toBe(true);
});

test("missingAssets names each absent file and passes present files and folders", () => {
  expect(
    missingAssets(["popcorn/static/index.html", "popcorn/static/sample", "popcorn/nope.txt"]),
  ).toEqual(["popcorn/nope.txt"]);
});
