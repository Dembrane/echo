import { type Section, type Values, walk } from "./define";

export type Source = "default" | "environment-file" | "process-env";

export interface Resolved {
  readonly path: string;
  readonly env: string;
  readonly source: Source;
  readonly secret: boolean;
  readonly public: boolean;
  readonly value: unknown;
}

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

export interface Loaded<T extends Section> {
  readonly values: Values<T>;
  readonly resolved: readonly Resolved[];
}

/**
 * Resolves every key from, in rising precedence: the schema default, the environment
 * file, the process environment. Collects every problem before failing so one boot
 * shows the whole list, and refuses secrets that arrive from a checked-in file.
 */
export function load<T extends Section>(
  schema: T,
  environmentFile: unknown,
  processEnv: Record<string, string | undefined>,
): Loaded<T> {
  const problems: string[] = [];
  const resolved: Resolved[] = [];
  const values: Record<string, unknown> = {};

  for (const [path, k] of walk(schema)) {
    const fromFile = get(environmentFile, path);
    const fromEnv = processEnv[k.meta.env];
    if (k.meta.secret && fromFile !== undefined) {
      problems.push(
        `${path} (${k.meta.env}) is a secret and must not be set in an environment file`,
      );
      continue;
    }
    const source: Source =
      fromEnv !== undefined
        ? "process-env"
        : fromFile !== undefined
          ? "environment-file"
          : "default";
    const raw = fromEnv ?? fromFile;
    const parsed = k.schema.safeParse(raw);
    if (!parsed.success) {
      const why = parsed.error.issues.map((i) => i.message).join("; ");
      problems.push(`${path} (${k.meta.env}): ${raw === undefined ? "missing" : why}`);
      continue;
    }
    set(values, path, parsed.data);
    resolved.push({
      path,
      env: k.meta.env,
      source,
      secret: k.meta.secret,
      public: k.meta.visibility === "public",
      value: parsed.data,
    });
  }

  if (problems.length) throw new ConfigError(problems);
  return { values: deepFreeze(values) as Values<T>, resolved };
}

/** Effective configuration safe to log or print: secrets replaced by whether they are set. */
export function describe(
  loaded: Loaded<Section>,
): Record<string, { value: unknown; source: Source }> {
  return Object.fromEntries(
    loaded.resolved.map((r) => [
      r.path,
      {
        value: r.secret ? (r.value === undefined ? "<unset>" : "<set>") : r.value,
        source: r.source,
      },
    ]),
  );
}

/** The subset browsers may read, served by the API so one frontend build runs in every environment. */
export function publicValues(loaded: Loaded<Section>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const r of loaded.resolved) if (r.public) set(out, r.path, r.value);
  return out;
}

function get(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function set(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur = obj;
  for (const part of parts.slice(0, -1)) {
    cur[part] ??= {};
    cur = cur[part] as Record<string, unknown>;
  }
  cur[parts.at(-1) as string] = value;
}

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === "object") {
    for (const v of Object.values(obj)) deepFreeze(v);
    Object.freeze(obj);
  }
  return obj;
}
