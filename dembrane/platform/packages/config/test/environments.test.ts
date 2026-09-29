import { expect, test } from "bun:test";
import { environments, loadConfig, schema } from "../src";
import { walk } from "../src/define";

const secrets = Object.fromEntries(
  [...walk(schema)]
    .filter(([, k]) => k.meta.secret)
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

test("a PR preview's key prefix is read; no environment sets it", () => {
  const plain = loadConfig({ APP_ENV: "preview", ...secrets }).values;
  expect(plain.files.s3Prefix).toBeUndefined();
  expect(plain.audio.s3Prefix).toBeUndefined();

  const pr = loadConfig({
    APP_ENV: "preview",
    ...secrets,
    FILES_S3_PREFIX: "pr-12/",
    STORAGE_S3_PREFIX: "pr-12/",
  }).values;
  expect(pr.files.s3Prefix).toBe("pr-12/");
  expect(pr.audio.s3Prefix).toBe("pr-12/");

  expect(() => loadConfig({ APP_ENV: "preview", ...secrets, FILES_S3_PREFIX: "../x" })).toThrow();
});
