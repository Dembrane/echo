import type { z } from "zod";

/** Who may read a key. `public` keys are served to browsers by the API; everything else never leaves the server. */
export type Visibility = "server" | "public";

export interface KeyMeta {
  /** Environment variable that can set or override the key. */
  readonly env: string;
  readonly description: string;
  /** Secrets come only from the process environment (Secret Manager on Cloud Run), never from a checked-in file. */
  readonly secret: boolean;
  readonly visibility: Visibility;
}

export interface Key<S extends z.ZodType = z.ZodType> {
  readonly kind: "key";
  readonly schema: S;
  readonly meta: KeyMeta;
}

export type Section = { readonly [name: string]: Key | Section };

export function key<S extends z.ZodType>(
  env: string,
  schema: S,
  opts: { description: string; secret?: boolean; public?: boolean },
): Key<S> {
  if (opts.secret && opts.public) throw new Error(`${env}: a secret cannot be public`);
  return {
    kind: "key",
    schema,
    meta: {
      env,
      description: opts.description,
      secret: opts.secret ?? false,
      visibility: opts.public ? "public" : "server",
    },
  };
}

export function defineSchema<T extends Section>(schema: T): T {
  const seen = new Map<string, string>();
  for (const [path, k] of walk(schema)) {
    const other = seen.get(k.meta.env);
    if (other) throw new Error(`${k.meta.env} is declared twice: ${other} and ${path}`);
    seen.set(k.meta.env, path);
  }
  return schema;
}

/** Typed values of a schema: what the app reads. */
export type Values<T> =
  T extends Key<infer S> ? z.output<S> : { readonly [K in keyof T]: Values<T[K]> };

/** What an environment file may set: any non-secret key, all optional. */
export type EnvironmentValues<T> =
  T extends Key<infer S> ? z.input<S> : { readonly [K in keyof T]?: EnvironmentValues<T[K]> };

export function* walk(section: Section, prefix = ""): Generator<[string, Key]> {
  for (const [name, node] of Object.entries(section)) {
    const path = prefix ? `${prefix}.${name}` : name;
    if ((node as Key).kind === "key") yield [path, node as Key];
    else yield* walk(node as Section, path);
  }
}
