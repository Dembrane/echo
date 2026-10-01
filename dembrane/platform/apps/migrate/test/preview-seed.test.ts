import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ORG_NAME } from "@dembrane/accounts";
import { MILLBROOK } from "@dembrane/samples";
import { PREVIEW_ADMIN_EMAIL, PREVIEW_SEED_ASSETS, previewSeedRefusal } from "../src/preview-seed";

const demos = new URL("../../../../demos", import.meta.url).pathname;
const preview = {
  APP_ENV: "preview",
  DATABASE_NAME: "echo_pr_42",
  PREVIEW_ADMIN_PASSWORD: "twelve-chars-at-least",
};

describe("the PR preview seed", () => {
  test("runs only on a PR preview's own database, with a real password", () => {
    expect(previewSeedRefusal(preview)).toBeNull();
    expect(previewSeedRefusal({ ...preview, APP_ENV: "next" })).toMatch(/not preview/);
    expect(previewSeedRefusal({ ...preview, DATABASE_NAME: "echo" })).toMatch(/echo_pr_/);
    expect(previewSeedRefusal({ ...preview, PREVIEW_ADMIN_PASSWORD: "short" })).toMatch(/12/);
  });

  // Previews are shared by link, so every organisation they hold is visibly made up.
  test("seeds only fictional organisations", () => {
    expect(MILLBROOK.org).toBe("Acme Civic (sample)");
    expect(ORG_NAME).toBe("Example Town Council (sample)");
    expect(PREVIEW_ADMIN_EMAIL).toBe("sameer+admin@dembrane.com");
  });

  test("the demo files it ships carry no contact details outside reserved domains", async () => {
    for (const asset of PREVIEW_SEED_ASSETS) {
      const text = await Bun.file(join(demos, asset.replace(/^demos\//, ""))).text();
      const emails = text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? [];
      expect(emails.filter((e) => !/\.(example|test)$|@example\.(com|org)$/.test(e))).toEqual([]);
      const hosts = [...text.matchAll(/https?:\/\/([^/\s"')]+)/g)].map((m) => m[1]);
      expect(
        hosts.filter((h) => !/(^|\.)(example|test)$|^example\.(com|org)$/.test(h ?? "")),
      ).toEqual([]);
    }
  });
});
