import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { qrSvgMarkup } from "../src/qr";

// Generated once by the Python service's qr_svg_markup (segno 1.6.6). Covers every mode
// segno picks on its own, all three byte encodings, versions 1 to 23 and inputs that fill a
// version exactly, so the padding and mask choices are exercised, not just the happy path.
interface Fixture {
  url: string;
  version: number;
  svg: string;
  logoHref?: string;
}

const fixtures: Fixture[] = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "qr.json"), "utf8"),
);

test("fixtures cover versions 2 to 15 and at least 40 inputs", () => {
  expect(fixtures.length).toBeGreaterThanOrEqual(40);
  const versions = new Set(fixtures.map((f) => f.version));
  for (let v = 2; v <= 15; v++) expect(versions.has(v)).toBe(true);
});

for (const [index, fixture] of fixtures.entries()) {
  const label = `${index} v${fixture.version} ${JSON.stringify(fixture.url.slice(0, 40))}`;
  test(`matches Python byte for byte: ${label}`, () => {
    const svg =
      fixture.logoHref === undefined
        ? qrSvgMarkup(fixture.url)
        : qrSvgMarkup(fixture.url, fixture.logoHref);
    expect(svg).toBe(fixture.svg);
  });
}

test("repeated calls return the cached markup", () => {
  const first = qrSvgMarkup("https://dembrane.com/cache");
  expect(qrSvgMarkup("https://dembrane.com/cache")).toBe(first);
});
