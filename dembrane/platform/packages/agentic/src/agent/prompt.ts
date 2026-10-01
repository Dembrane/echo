import {
  CANVAS_INSIGHT_EXAMPLE,
  CANVAS_LIBRARY_LINE,
  CANVAS_PROMPT_SECTION,
  NO_CANVAS_LIBRARY_LINE,
  RUNTIME_NOTE_HEADING,
  SYSTEM_PROMPT_HEAD,
  SYSTEM_PROMPT_TAIL,
} from "./text";

const MAX_AMBIENT_MEMORY_ITEMS = 12;
const MAX_AMBIENT_MEMORY_CHARS = 3000;
export const MAX_CANVAS_ACTIVITY_RUNS = 5;
const MAX_CANVAS_ACTIVITY_DETAIL_CHARS = 220;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));

/**
 * The system prompt. With canvas off every canvas mention is stripped, so the model
 * never learns canvas exists (its tools are not registered either).
 */
export function systemPromptFor(canvasEnabled: boolean): string {
  if (canvasEnabled)
    return `${SYSTEM_PROMPT_HEAD}\n${CANVAS_PROMPT_SECTION}\n${SYSTEM_PROMPT_TAIL}`;
  const prompt = `${SYSTEM_PROMPT_HEAD}\n${SYSTEM_PROMPT_TAIL}`;
  if (!prompt.includes(CANVAS_INSIGHT_EXAMPLE) || !prompt.includes(CANVAS_LIBRARY_LINE))
    throw new Error("Canvas prompt markers drifted; update systemPromptFor()");
  return prompt
    .replace(CANVAS_INSIGHT_EXAMPLE, "")
    .replace(CANVAS_LIBRARY_LINE, NO_CANVAS_LIBRARY_LINE);
}

/** "What you remember": the newest memories, bounded in count and size. */
export function formatMemorySection(memories: readonly unknown[]): string {
  const rows = memories.filter(isObj);
  if (!rows.length) return "";
  // Python's sort is stable with reverse=True keeping equal keys in input order.
  const sorted = rows
    .map((m, i) => ({ m, i, k: str(m.updated_at) }))
    .sort((a, b) => (a.k === b.k ? a.i - b.i : a.k < b.k ? 1 : -1))
    .map((x) => x.m);
  const lines = ["## What you remember"];
  let used = (lines[0] as string).length;
  for (const memory of sorted.slice(0, MAX_AMBIENT_MEMORY_ITEMS)) {
    const content = str(memory.content).trim();
    if (!content) continue;
    const scope = str(memory.scope || "memory").trim() || "memory";
    const key = str(memory.memory_key).trim();
    let line = `- ${key ? `${scope}/${key}` : scope}: ${content}`;
    const remaining = MAX_AMBIENT_MEMORY_CHARS - used;
    if (remaining <= 0) break;
    if (line.length > remaining) line = `${line.slice(0, Math.max(0, remaining - 1)).trimEnd()}...`;
    lines.push(line);
    used += line.length + 1;
    if (used >= MAX_AMBIENT_MEMORY_CHARS) break;
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

function truncateDetail(detail: unknown): string {
  const s = str(detail).trim();
  if (s.length <= MAX_CANVAS_ACTIVITY_DETAIL_CHARS) return s;
  return `${s.slice(0, MAX_CANVAS_ACTIVITY_DETAIL_CHARS - 3).trimEnd()}...`;
}

function runsFor(canvas: Obj): Obj[] {
  const raw = Array.isArray(canvas.recent_runs) ? canvas.recent_runs : canvas.runs;
  if (Array.isArray(raw)) return raw.filter(isObj);
  const loop = canvas.loop;
  if (!isObj(loop)) return [];
  if (!loop.last_run_status && !loop.last_run_detail) return [];
  return [
    {
      status: loop.last_run_status,
      detail: loop.last_run_detail,
      started_at: loop.last_run_started_at,
    },
  ];
}

/** "Canvas activity since last turn", from the chat's canvas-activity read. */
export function formatCanvasActivitySection(payload: unknown): string {
  if (!isObj(payload)) return "";
  const canvases = payload.canvases;
  if (!Array.isArray(canvases) || !canvases.length) return "";
  const lines = ["## Canvas activity since last turn"];
  let rendered = 0;
  for (const canvas of canvases) {
    if (!isObj(canvas)) continue;
    const name = str(canvas.name || canvas.id || "Canvas").trim();
    const id = str(canvas.id).trim();
    const runs = runsFor(canvas);
    if (!runs.length) continue;
    lines.push(`- ${id ? `${name} (${id})` : name}`);
    for (const run of runs) {
      const status = str(run.status || "unknown").trim() || "unknown";
      const detail = truncateDetail(run.detail);
      const startedAt = str(run.started_at).trim();
      const prefix = startedAt ? `  - ${status} at ${startedAt}` : `  - ${status}`;
      lines.push(detail ? `${prefix}: ${detail}` : prefix);
      rendered++;
      if (rendered >= MAX_CANVAS_ACTIVITY_RUNS) return lines.join("\n");
    }
  }
  return rendered ? lines.join("\n") : "";
}

/**
 * A runtime note rides in the system instruction for one model call, never as a message:
 * Gemini has only user and model turns, so a note sent as a user turn reads as the host
 * speaking, and a retry ending on the model's own turn is rejected by Vertex.
 */
export function withRuntimeNote(system: string, note: string): string {
  return `${system}\n\n${RUNTIME_NOTE_HEADING}\n${note}`;
}
