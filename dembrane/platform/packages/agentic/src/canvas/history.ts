import { freshCanvasState, type Obj } from "./ledgers";
import type { CanvasStore } from "./service";

const asId = (v: unknown): string | null => {
  const raw = v && typeof v === "object" ? (v as Obj).id : v;
  const s = String(raw ?? "").trim();
  return s && raw !== null && raw !== undefined ? s : null;
};
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const or = (...vs: unknown[]) => vs.find((v) => v !== null && v !== undefined && v !== "") ?? null;

const cause = (type: string, runChatId: string | null, chatId?: unknown, messageId?: unknown) => ({
  type,
  chat_id: asId(chatId),
  message_id: asId(messageId),
  run_chat_id: runChatId,
});

function detailItems(detail: unknown): string[] {
  const text = str(detail).trim();
  if (!text) return [];
  const parts = text
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length ? parts : [text];
}

const keptOut = (items: string[]) =>
  items.filter((i) => i.toLowerCase().includes("rejected") || i.toLowerCase().includes("kept out"));

/** Version numbers of the ok generations, oldest first, as the audit tab counts them. */
function versionMap(generations: Obj[]): Map<string, number> {
  const ok = generations
    .filter((g) => str(g.status) === "ok")
    .sort((a, b) =>
      str(a.created_at) < str(b.created_at) ? -1 : str(a.created_at) > str(b.created_at) ? 1 : 0,
    );
  const out = new Map<string, number>();
  ok.forEach((g, i) => {
    if (str(g.id).trim()) out.set(str(g.id), i + 1);
  });
  return out;
}

/**
 * The audit entries of a canvas, newest first: loop runs, generations no run produced,
 * config revisions and host items, each as {at, kind, version, cause, heard, changes,
 * kept_out}. The Audit tab and readCanvasHistory both read this shape.
 */
export async function buildCanvasHistory(store: CanvasStore, reportId: string, limit = 30) {
  const capped = Math.max(1, Math.min(limit, 100));
  const loop = (await store.historyLoop(reportId)) ?? {};
  const loopId = asId(loop.id);
  const runChatId = asId(loop.created_from_chat_id);
  const generations = await store.historyGenerations(reportId, capped);
  const versions = versionMap(generations);
  const byId = new Map(generations.filter((g) => g.id).map((g) => [str(g.id), g]));
  const runs = loopId ? await store.historyRuns(loopId, capped) : [];
  const configs = await store.historyConfigs(reportId, Math.min(capped, 20));

  const entries: Obj[] = [];
  const seen = new Set<string>();
  for (const run of runs) {
    const generationId = asId(run.generation_id);
    const generation = byId.get(generationId ?? "");
    if (generationId) seen.add(generationId);
    const noChange = str(run.status).trim() === "no_op" || !generationId;
    const items = detailItems(run.detail);
    entries.push({
      at: or(run.started_at, run.created_at),
      kind: noChange ? "no change" : "run",
      version: versions.get(generationId ?? "") ?? null,
      cause: cause(
        generation ? str(or(generation.tick_kind, "canvas_loop")) : "canvas_loop",
        runChatId,
      ),
      heard: noChange ? [] : items,
      changes: noChange ? ["no change \u2014 nothing new heard"] : items,
      kept_out: keptOut(items),
    });
  }
  for (const g of generations) {
    const id = asId(g.id);
    if (!id || seen.has(id)) continue;
    const items = detailItems(g.detail);
    entries.push({
      at: g.created_at ?? null,
      kind: "generation",
      version: versions.get(id) ?? null,
      cause: cause(str(or(g.tick_kind, "generation")), runChatId),
      heard: items,
      changes: items,
      kept_out: keptOut(items),
    });
  }
  for (const r of configs) {
    const brief = str(r.brief).trim();
    entries.push({
      at: r.created_at ?? null,
      kind: "config revision",
      version: null,
      cause: cause(
        str(or(r.note, "brief update")),
        runChatId,
        or(r.chat_id, r.applied_from_chat_id),
      ),
      heard: [],
      changes: brief ? [[...brief].slice(0, 220).join("")] : [],
      kept_out: [],
    });
  }
  for (const item of freshCanvasState(loop).host_items as Obj[]) {
    if (!item || typeof item !== "object") continue;
    const removed = Boolean(item.removed_at);
    const text = str(item.text).trim();
    entries.push({
      at: or(item.removed_at, item.added_at),
      kind: removed ? "host item removed" : "host item added",
      version: null,
      cause: cause("host", runChatId, item.chat_id, item.message_id),
      heard: removed ? [] : [text],
      changes: [text],
      kept_out: removed ? [text] : [],
    });
  }
  // Python's sorted(reverse=True) is stable, so equal keys keep their insertion order.
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const x = str(a.e.at);
      const y = str(b.e.at);
      return x < y ? 1 : x > y ? -1 : a.i - b.i;
    })
    .slice(0, capped)
    .map(({ e }) => e);
}
