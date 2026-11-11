import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

// Text the browser downloads; images, fonts and audio are compressed already.
const TEXT = /\.(js|mjs|css|html|svg|json|txt|xml|webmanifest|wasm)$/;
// Below this, headers outweigh what compression saves.
const MIN_BYTES = 1024;

/**
 * Writes a .br and a .gz copy next to each text file in the built frontend, at the highest
 * levels, once per build. The web server sends whichever copy the browser accepts.
 */
export async function precompress(dir: string): Promise<void> {
  const files = await readdir(dir, { recursive: true });
  await Promise.all(
    files
      .filter((f) => TEXT.test(f))
      .map(async (f) => {
        const path = join(dir, f);
        const bytes = await readFile(path);
        if (bytes.length < MIN_BYTES) return;
        const br = brotliCompressSync(bytes, {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
            [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
          },
        });
        const gz = gzipSync(bytes, { level: 9 });
        if (br.length < bytes.length) await writeFile(`${path}.br`, br);
        if (gz.length < bytes.length) await writeFile(`${path}.gz`, gz);
      }),
  );
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) throw new Error("usage: bun precompress.ts <dist dir>");
  await precompress(dir);
}
