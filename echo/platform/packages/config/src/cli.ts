#!/usr/bin/env bun
/**
 * echo-config: inspect and check configuration without running the app.
 *   show <env>          effective values and where each came from (secrets redacted)
 *   diff <env> <env>    keys whose value differs between two environments
 *   secrets <env>       secret names the environment must receive (feeds Terraform and CI)
 *   check               every environment file is valid; every declared key is read somewhere
 * Placeholder values stand in for secrets so files can be checked without them.
 */
import { Glob } from "bun";
import { walk } from "./define";
import { describe, type EnvironmentName, environments, schema } from "./index";
import { ConfigError, load } from "./load";

const names = Object.keys(environments) as EnvironmentName[];

function resolveFor(env: EnvironmentName, withPlaceholders = true) {
  const processEnv: Record<string, string> = { APP_ENV: env };
  if (withPlaceholders) {
    for (const [, k] of walk(schema)) {
      if (k.meta.secret) processEnv[k.meta.env] = placeholder(k.meta.env);
    }
  }
  return load(schema, environments[env], processEnv);
}

function placeholder(envName: string): string {
  return envName.endsWith("_URL") ? "postgres://placeholder@localhost/placeholder" : "x".repeat(48);
}

function assertEnv(v: string | undefined): EnvironmentName {
  if (!v || !names.includes(v as EnvironmentName)) {
    throw new Error(`environment must be one of: ${names.join(", ")}`);
  }
  return v as EnvironmentName;
}

async function unreadKeys(root: string): Promise<string[]> {
  const glob = new Glob("{apps,packages}/*/src/**/*.ts");
  let code = "";
  for await (const f of glob.scan(root)) {
    if (f.startsWith("packages/config/")) continue;
    code += await Bun.file(`${root}/${f}`).text();
  }
  // Public keys are read by browsers through /config.json, so they count as read.
  return [...walk(schema)]
    .filter(([, k]) => k.meta.visibility !== "public")
    .map(([path]) => path)
    .filter((p) => !code.includes(`.${p}`));
}

const [cmd, a, b] = process.argv.slice(2);
const out = (s: string) => process.stdout.write(`${s}\n`);
try {
  if (cmd === "show") {
    const env = assertEnv(a);
    for (const [path, { value, source }] of Object.entries(describe(resolveFor(env)))) {
      out(`${path.padEnd(34)} ${(JSON.stringify(value) ?? "<unset>").padEnd(48)} ${source}`);
    }
  } else if (cmd === "diff") {
    const [x, y] = [describe(resolveFor(assertEnv(a))), describe(resolveFor(assertEnv(b)))];
    for (const path of Object.keys(x)) {
      const [vx, vy] = [JSON.stringify(x[path]?.value), JSON.stringify(y[path]?.value)];
      if (vx !== vy) out(`${path.padEnd(34)} ${a}=${vx}  ${b}=${vy}`);
    }
  } else if (cmd === "secrets") {
    assertEnv(a);
    for (const [, k] of walk(schema)) if (k.meta.secret) out(k.meta.env);
  } else if (cmd === "check") {
    const problems: string[] = [];
    for (const env of names) {
      try {
        resolveFor(env);
      } catch (e) {
        if (e instanceof ConfigError) problems.push(...e.problems.map((p) => `${env}: ${p}`));
        else throw e;
      }
    }
    const root = new URL("../../..", import.meta.url).pathname;
    for (const path of await unreadKeys(root))
      problems.push(`${path} is declared but nothing reads it`);
    if (problems.length) {
      out(problems.join("\n"));
      process.exit(1);
    }
    out(`config ok: ${names.length} environments, ${[...walk(schema)].length} keys`);
  } else {
    out("usage: echo-config show <env> | diff <env> <env> | secrets <env> | check");
    process.exit(2);
  }
} catch (e) {
  out(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
