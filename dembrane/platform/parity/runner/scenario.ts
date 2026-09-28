import type { users } from "../fixtures";

export type As = keyof typeof users | "anonymous";

/** Values a scenario's `prepare` hands to the request: ids, codes and tokens minted on that side. */
export type Vars = Record<string, unknown>;

/** One API as `prepare` sees it: sign in as a fixture user and make raw requests. */
export interface Side {
  readonly base: string;
  login(as: As): Promise<string | null>;
  /** A request against this side; redirects are never followed, so a 302 stays visible. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

/** A value fixed in the scenario, or computed from what `prepare` returned on this side. */
export type PerSide<T> = T | ((vars: Vars) => T);

/**
 * One request made the same way to both APIs. A scenario passes when status, body and
 * the rows it changed match after normalisation. `differs` records an intended change
 * (a fixed hole, a removed legacy path) and must say why; the runner then checks that the
 * two sides really differ, so a stale note cannot hide a regression.
 */
export interface Scenario {
  readonly name: string;
  readonly as: As;
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE" | "OPTIONS";
  readonly path: PerSide<string>;
  /**
   * JSON body; a function (sync or async) is evaluated per side at call time, for time-based
   * codes, and receives what `prepare` returned.
   */
  readonly body?: unknown;
  /** Multipart form fields instead of a JSON body; a file is { filename, type, base64 }. */
  readonly form?: PerSide<Record<string, string | FormFile>>;
  /** A body sent byte for byte (malformed JSON, say); content-type comes from `headers`. */
  readonly raw?: PerSide<string>;
  /** application/x-www-form-urlencoded fields, the way OAuth clients post to /token. */
  readonly urlencoded?: PerSide<Record<string, string>>;
  readonly headers?: PerSide<Record<string, string>>;
  readonly query?: PerSide<Record<string, string>>;
  /**
   * Multi-step flows (an OAuth dance, a token minted on the old side and used on the new):
   * runs after setup and before the snapshot, on the side under test. The result feeds the
   * request's PerSide values; its keys not starting with "_" are compared too, so every
   * intermediate answer is part of the parity check. `sides.old` lets a scenario mint state
   * with the Python API and then call the side under test with it.
   */
  readonly prepare?: (side: Side, sides: { readonly old: Side }) => Promise<Vars>;
  /** Response headers compared alongside the body (Location of a redirect, WWW-Authenticate). */
  readonly responseHeaders?: readonly string[];
  /**
   * SQL run on the fresh copy before the request, identically for both sides, for state
   * the seed does not have (invites, an observer's visible project, a scheduled report).
   * One script or a list of statements; ids it inserts count as seed ids. Not in the diff.
   */
  readonly setup?: string | readonly string[];
  readonly differs?: string;
  /**
   * The route was pruned from the new API on purpose, with the reason. The runner skips the
   * old side and checks that the new one answers 404, so a route that comes back unnoticed
   * fails here. Drop the scenario once the old API is retired.
   */
  readonly removed?: string;
  /** Response fields whose values legitimately change per run (besides timestamps and new ids). */
  readonly ignoreFields?: readonly string[];
}

export interface FormFile {
  readonly filename: string;
  readonly type: string;
  readonly base64: string;
}

export function scenarios(list: Scenario[]): Scenario[] {
  const names = new Set<string>();
  for (const s of list) {
    if (names.has(s.name)) throw new Error(`duplicate scenario name: ${s.name}`);
    names.add(s.name);
  }
  return list;
}
