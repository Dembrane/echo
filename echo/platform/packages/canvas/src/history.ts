import { freshCanvasState, pyCompare } from "./ledgers";
import { directusTime, isRecord, type Json, orStr, pyStr, truthy } from "./py";
import type { CanvasStore, Row } from "./storage";

/**
 * Audit entries of a canvas, newest first: runs, generations nobody ran, config revisions
 * and host items. The Audit tab renders them and agent tools read them, so the shape
 * ({at, kind, version, cause, heard, changes, kept_out}) stays stable.
 */

function asId(v: unknown): string | null {
  const value = isRecord(v) ? v.id : v;
  const s = orStr(value).trim();
  return s || null;
}

function cause(type: string, chat?: unknown, message?: unknown, runChat?: unknown): Json {
  return {
    type,
    chat_id: asId(chat),
    message_id: asId(message),
    run_chat_id: asId(runChat),
  };
}

function detailItems(detail: unknown): string[] {
  const text = orStr(detail).trim();
  if (!text) return [];
  const parts = text
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length ? parts : [text];
}

const keptOut = (items: string[]) =>
  items.filter((i) => i.toLowerCase().includes("rejected") || i.toLowerCase().includes("kept out"));

/** Directus returned timestamps as ISO strings; history sorts on those strings. */
function t(v: unknown): string | null {
  return v === null || v === undefined ? null : directusTime(v);
}

export async function buildCanvasHistory(
  store: CanvasStore,
  reportId: string,
  limit = 30,
): Promise<Json[]> {
  const capped = Math.max(1, Math.min(limit, 100));
  const { loop, generations, runs, configs } = await store.historyRows(reportId, capped);
  const runChat = asId(loop.created_from_chat_id);
  const okOrdered = generations
    .filter((g) => orStr(g.status) === "ok")
    .sort((a, b) => pyCompare(orStr(t(a.created_at)), orStr(t(b.created_at))));
  const versions = new Map<string, number>();
  okOrdered.forEach((g, i) => {
    if (orStr(g.id).trim()) versions.set(pyStr(g.id), i + 1);
  });
  const byId = new Map<string, Row>(
    generations.filter((g) => truthy(g.id)).map((g) => [pyStr(g.id), g]),
  );

  const entries: Json[] = [];
  const seen = new Set<string>();
  for (const run of runs) {
    const generationId = asId(run.generation_id);
    const generation = byId.get(generationId ?? "");
    if (generationId) seen.add(generationId);
    const status = orStr(run.status).trim();
    const noChange = status === "no_op" || !generationId;
    const items = detailItems(run.detail);
    entries.push({
      at: t(run.started_at) ?? t(run.created_at),
      kind: noChange ? "no change" : "run",
      version: versions.get(generationId ?? "") ?? null,
      cause: cause(
        generation ? orStr(generation.tick_kind, "canvas_loop") : "canvas_loop",
        null,
        null,
        runChat,
      ),
      heard: noChange ? [] : items,
      changes: noChange ? ["no change — nothing new heard"] : items,
      kept_out: keptOut(items),
    });
  }
  for (const generation of generations) {
    const id = asId(generation.id);
    if (!id || seen.has(id)) continue;
    const items = detailItems(generation.detail);
    entries.push({
      at: t(generation.created_at),
      kind: "generation",
      version: versions.get(id) ?? null,
      cause: cause(orStr(generation.tick_kind, "generation"), null, null, runChat),
      heard: items,
      changes: items,
      kept_out: keptOut(items),
    });
  }
  for (const revision of configs) {
    const brief = orStr(revision.brief).trim();
    entries.push({
      at: t(revision.created_at),
      kind: "config revision",
      version: null,
      cause: cause(
        orStr(revision.note, "brief update"),
        revision.chat_id || revision.applied_from_chat_id,
        null,
        runChat,
      ),
      heard: [],
      changes: brief ? [brief.slice(0, 220)] : [],
      kept_out: [],
    });
  }
  const state = freshCanvasState(loop as Json);
  for (const item of state.host_items) {
    if (!isRecord(item)) continue;
    const removed = truthy(item.removed_at);
    const text = orStr(item.text).trim();
    entries.push({
      at: truthy(item.removed_at) ? item.removed_at : (item.added_at ?? null),
      kind: removed ? "host item removed" : "host item added",
      version: null,
      cause: cause("host", item.chat_id, item.message_id, runChat),
      heard: removed ? [] : [text],
      changes: [text],
      kept_out: removed ? [text] : [],
    });
  }
  return entries.sort((a, b) => -pyCompare(orStr(a.at), orStr(b.at))).slice(0, capped);
}
