import type { users } from "../fixtures";

export type As = keyof typeof users | "anonymous";

/**
 * One request made the same way to both APIs. A scenario passes when status, body and
 * the rows it changed match after normalisation. `differs` records an intended change
 * (a fixed hole, a removed legacy path) and must say why; the runner then checks that the
 * two sides really differ, so a stale note cannot hide a regression.
 */
export interface Scenario {
  readonly name: string;
  readonly as: As;
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly path: string;
  /** JSON body; a function is evaluated per side at call time (for time-based codes). */
  readonly body?: unknown;
  /** Multipart form fields instead of a JSON body; a file is { filename, type, base64 }. */
  readonly form?: Record<string, string | FormFile>;
  readonly headers?: Record<string, string>;
  readonly query?: Record<string, string>;
  /**
   * SQL run on the fresh copy before the request, identically for both sides, for state
   * the seed does not have (invites, notifications). Ids it inserts count as seed ids.
   */
  readonly setup?: string;
  readonly differs?: string;
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
