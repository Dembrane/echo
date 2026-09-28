import { createHash } from "node:crypto";

/**
 * A uuid (version 5 layout) derived from a key. Turn work uses it for every row it writes,
 * so a step that runs again after a crash writes the same ids instead of new ones.
 */
export function stableUuid(key: string): string {
  const h = createHash("sha1").update(`echo.agentic:${key}`).digest();
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x50;
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
