import local from "../environments/local";
import next from "../environments/next";
import prod from "../environments/prod";
import test from "../environments/test";
import type { EnvironmentValues, Values } from "./define";
import { type Loaded, load } from "./load";
import { type Schema, schema } from "./schema";

export { ConfigError, describe, publicValues } from "./load";
export { schema } from "./schema";

export type Config = Values<Schema>;
export type Environment = EnvironmentValues<Schema>;
export type EnvironmentName = Config["app"]["env"];

export const environments: Record<EnvironmentName, unknown> = { local, test, next, prod };

/** Loads configuration for the environment named by APP_ENV. Call once at boot, in the composition root. */
export function loadConfig(
  processEnv: Record<string, string | undefined> = process.env,
): Loaded<Schema> {
  const name = processEnv.APP_ENV as EnvironmentName | undefined;
  const file = name && name in environments ? environments[name] : undefined;
  return load(schema, file, processEnv);
}
