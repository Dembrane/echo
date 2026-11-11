import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { precompress } from "../src/precompress";

test("text files get .br and .gz copies; small and binary files do not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "echo-precompress-"));
  mkdirSync(join(dir, "assets"));
  const js = "console.log('hello');\n".repeat(200);
  writeFileSync(join(dir, "assets", "app-abc.js"), js);
  writeFileSync(join(dir, "index.html"), `<html>${"<div></div>".repeat(200)}</html>`);
  writeFileSync(join(dir, "assets", "tiny.css"), "a{}");
  writeFileSync(join(dir, "assets", "logo.png"), Buffer.alloc(4096, 7));

  await precompress(dir);

  const br = readFileSync(join(dir, "assets", "app-abc.js.br"));
  const gz = readFileSync(join(dir, "assets", "app-abc.js.gz"));
  expect(brotliDecompressSync(br).toString()).toBe(js);
  expect(gunzipSync(gz).toString()).toBe(js);
  expect(br.length).toBeLessThan(js.length);
  expect(existsSync(join(dir, "index.html.br"))).toBe(true);
  expect(existsSync(join(dir, "assets", "tiny.css.br"))).toBe(false);
  expect(existsSync(join(dir, "assets", "logo.png.br"))).toBe(false);
});
