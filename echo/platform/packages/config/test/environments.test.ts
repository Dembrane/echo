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
