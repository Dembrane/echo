import { createHash } from "node:crypto";
import { popcornShared } from "@echo/analysis";
import { PyFloat } from "../py";

/**
 * Small Python behaviours the tick's output depends on: repr() in the gate texts the
 * model reads back, Unicode word boundaries (JS \b is ASCII only), float-ness for the
 * saved-run JSON, and the bounded concurrency asyncio gave the Python tick.
 */

/** A Python \w character, and Python's \b before and after one. */
export const { W, WB_START, WB_END } = popcornShared;

export const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** repr() of a str, as the f-string `{x!r}` prints it. */
export function pyRepr(v: unknown): string {
  if (typeof v !== "string") {
    if (v === null || v === undefined) return "None";
    if (v === true) return "True";
    if (v === false) return "False";
    return String(v);
  }
  const q = v.includes("'") && !v.includes('"') ? '"' : "'";
  let body = "";
  for (const ch of v) {
    const code = ch.codePointAt(0) as number;
    if (ch === "\\") body += "\\\\";
    else if (ch === "\n") body += "\\n";
    else if (ch === "\r") body += "\\r";
    else if (ch === "\t") body += "\\t";
    else if (ch === q) body += `\\${q}`;
    else if (code < 0x20 || code === 0x7f) body += `\\x${code.toString(16).padStart(2, "0")}`;
    else body += ch;
  }
  return `${q}${body}${q}`;
}

/**
 * A float computed in this tick. Python keeps it a float, so the saved run prints it
 * with its decimal point (1.0); through Directus's JSON it becomes a plain number, which
 * is what toJSON gives the state row.
 */
export class TickFloat extends PyFloat {
  toJSON(): number {
    return this.value;
  }
}

export const f = (x: number) => new TickFloat(x);

export function sha1Hex(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex");
}

/** asyncio.Semaphore */
export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly size: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.size) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

/** asyncio.Lock */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release = () => {};
    this.tail = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** asyncio.wait_for: a TimeoutError whose str() is empty, as Python's is. */
export class TickTimeout extends Error {
  constructor() {
    super("");
    this.name = "TimeoutError";
  }
}

export async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new TickTimeout());
    }, ms);
  });
  try {
    return await Promise.race([run(ctrl.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Several failures at once, as a TaskGroup raises them. */
export class FailureGroup extends Error {
  constructor(readonly errors: readonly unknown[]) {
    super("unhandled errors in a TaskGroup");
  }
}

/**
 * What failed, in the outcome line: a group's own message says nothing, its members do.
 * Python's str(exc)[:300], or the type's name when that is empty.
 */
export function failureText(exc: unknown): string {
  if (exc instanceof FailureGroup) return exc.errors.map(failureText).join("; ");
  if (exc instanceof Error) return exc.message.slice(0, 300) || exc.name;
  return String(exc).slice(0, 300);
}

/** str(exc) for an outcome line. */
export const errText = (exc: unknown) => (exc instanceof Error ? exc.message : String(exc));

/** asyncio.gather(..., return_exceptions=True) */
export async function settle<T>(ps: readonly Promise<T>[]): Promise<(T | Error)[]> {
  const out = await Promise.allSettled(ps);
  return out.map((r) =>
    r.status === "fulfilled"
      ? r.value
      : r.reason instanceof Error
        ? r.reason
        : new Error(String(r.reason)),
  );
}

/**
 * A TaskGroup: every coroutine runs, the first failure fails the group, and the others'
 * results are not waited for once one has failed.
 */
export async function all<T>(ps: readonly Promise<T>[]): Promise<T[]> {
  try {
    return await Promise.all(ps);
  } catch (err) {
    for (const p of ps) p.catch(() => {});
    throw new FailureGroup([err]);
  }
}

/** Python code points: len(), and s[:n]. */
export const pyLen = (s: string) => [...s].length;
