import { expect, test } from "bun:test";
import { environments, loadConfig, schema, together } from "../src";
import { walk } from "../src/define";

const secrets = Object.fromEntries(
  [...walk(schema)]
    .filter(([path, k]) => k.meta.secret && !together.flat().includes(path))
    .map(([, k]) => [
      k.meta.env,
      k.meta.env.endsWith("_URL") ? "postgres://u@h/d" : "s".repeat(48),
    ]),
);

for (const name of Object.keys(environments)) {
  test(`${name} environment resolves with its secrets supplied`, () => {
    const { values } = loadConfig({ APP_ENV: name, ...secrets });
    expect(values.app.env).toBe(name as typeof values.app.env);
  });
}

test("a PR preview's key prefix and pull request are read; no environment sets them", () => {
  const plain = loadConfig({ APP_ENV: "preview", ...secrets }).values;
  expect(plain.files.s3Prefix).toBeUndefined();
  expect(plain.audio.s3Prefix).toBeUndefined();
  expect(plain.web.previewPr).toBeUndefined();

  const pr = loadConfig({
    APP_ENV: "preview",
    ...secrets,
    FILES_S3_PREFIX: "pr-12/",
    STORAGE_S3_PREFIX: "pr-12/",
    WEB_PREVIEW_PR: "12",
  }).values;
  expect(pr.files.s3Prefix).toBe("pr-12/");
  expect(pr.audio.s3Prefix).toBe("pr-12/");
  expect(pr.web.previewPr).toBe(12);
  expect(pr.web.previewRepo).toBe("Dembrane/echo");

  expect(() => loadConfig({ APP_ENV: "preview", ...secrets, FILES_S3_PREFIX: "../x" })).toThrow();
});

test("previews and staging name their sign-in cookies; the others keep the default name", () => {
  const prefix = (name: string) =>
    loadConfig({ APP_ENV: name, ...secrets }).values.auth.cookiePrefix;
  expect(prefix("preview")).toBe("dembrane-preview");
  expect(prefix("staging")).toBe("dembrane-staging");
  expect(prefix("prod")).toBeUndefined();
  expect(prefix("local")).toBeUndefined();
  expect(() => loadConfig({ APP_ENV: "preview", ...secrets, AUTH_COOKIE_PREFIX: "a b" })).toThrow();
});
