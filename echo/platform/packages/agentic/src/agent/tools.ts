import { z } from "zod";
import type { AgentData, Json, TurnContext } from "./data";
import { type Knowledge, ValueError } from "./knowledge";
import { TOOL_DESCRIPTIONS } from "./text";

/**
 * The assistant's 46 tools, with the names, arguments and results of the Python agent.
 * Dashboard cards and the tool activity list read the result keys (kind, type,
 * visible_to_user and the fields next to them), so they stay key for key.
 *
 * - UI tools render a card in the chat (UI_TOOLS).
 * - Read tools fetch project data or product knowledge for the model only.
 * - Write tools change durable state through the same service operations as the
 *   matching /api/agentic routes, as the caller.
 */

export type ToolGroup = "ui" | "read" | "write";

/** What a tool call can reach: the turn, its data access, and caches shared by one turn. */
export interface ToolEnv {
  readonly ctx: TurnContext;
  readonly data: AgentData;
  readonly knowledge: Knowledge;
  readonly now: () => Date;
  readonly turn: TurnMemory;
}

/** Caches the Python graph kept for one turn. Rebuilt from the turn's messages on replay. */
export interface TurnMemory {
  readonly keywordCache: Map<string, Json>;
  consecutiveEmptyKeywordSearches: number;
  readonly conversations: Map<string, Json>;
}

export interface ToolDef {
  readonly name: string;
  readonly group: ToolGroup;
  readonly canvas: boolean;
  readonly description: string;
  readonly schema: z.ZodObject;
  run(args: Record<string, unknown>, env: ToolEnv): Promise<unknown>;
}

export const UI_TOOLS: ReadonlySet<string> = new Set([
  "navigateTo",
  "proposeCanvas",
  "proposeGoal",
  "proposeProjectUpdate",
  "proposeTagsUpdate",
  "noteInsight",
  "editInsight",
  "retractInsight",
  "sendProgressUpdate",
  "ack",
  "updatePlan",
]);

export const CANVAS_TOOL_NAMES: ReadonlySet<string> = new Set([
  "proposeCanvas",
  "listCanvases",
  "readCanvasHistory",
  "editCanvas",
  "addToCanvas",
  "removeFromCanvas",
  "pauseCanvasLoop",
  "resumeCanvasLoop",
  "stopCanvasLoop",
]);

/**
 * Old tool names from before the wave 32 rename. The model may still produce one from
 * habit; it runs as the new tool. Replayed history cannot carry them: only text crosses
 * turns, and within a turn every call names a registered tool.
 */
export const TOOL_NAME_RENAMES: Readonly<Record<string, string>> = {
  findConvosByKeywords: "findConversationsByKeywords",
  listConvoSummary: "listConversationSummary",
  listConvoFullTranscript: "listConversationFullTranscript",
  grepConvoSnippets: "grepConversationSnippets",
  reachOutToDembrane: "reachOutToDembraneSupport",
  recordInsight: "noteInsight",
};

const DASHBOARD_PAGES = [
  "overview",
  "chats",
  "monitor",
  "library",
  "host-guide",
  "report",
  "conversations",
  "settings",
  "portal-editor",
] as const;
const NAVIGATION_LABELS: Readonly<Record<string, string>> = {
  overview: "overview",
  chats: "chats",
  monitor: "monitor",
  library: "library",
  "host-guide": "host guide",
  report: "report",
  conversations: "conversations",
  settings: "settings",
  "portal-editor": "portal editor",
};
const INSIGHT_KINDS = ["capability_gap", "friction", "wish", "praise"] as const;
const PLAN_MAX_STEPS = 6;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const s = (v: unknown) =>
  typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
/** Python's `x or y`: the first truthy value. */
const or = (...vs: unknown[]) => {
  for (const v of vs) if (v) return v;
  return vs[vs.length - 1] ?? null;
};
/** Python's sorted() of strings: by code point. */
const pySorted = (xs: Iterable<string>) => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
/** A Python list's repr, as ValueError messages printed them. */
const pyRepr = (xs: readonly string[]) => `[${xs.map((x) => pyStrRepr(x)).join(", ")}]`;
function pyStrRepr(x: string): string {
  const q = x.includes("'") && !x.includes('"') ? '"' : "'";
  const body = x.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
  return `${q}${q === "'" ? body.replace(/'/g, "\\'") : body}${q}`;
}

export function normalizePortalLanguage(language: unknown): string {
  const v = s(language).trim();
  return !v || v === "default" ? "en" : v;
}

// ── conversation helpers ──────────────────────────────────────────────────

function normalizeConversation(
  raw: Obj,
  projectId: string,
  fallbackProjectId?: string,
): Obj | null {
  let id = raw.id;
  if (typeof id !== "string") id = raw.conversation_id;
  if (typeof id !== "string" || !id) return null;
  let pid: unknown = raw.projectId;
  if (isObj(pid)) pid = pid.id;
  if (typeof pid !== "string") pid = raw.project_id;
  if (isObj(pid)) pid = pid.id;
  if (typeof pid !== "string") pid = fallbackProjectId;
  if (typeof pid !== "string" || pid !== projectId) return null;
  return {
    conversation_id: id,
    project_id: pid,
    project_name: or(raw.projectName, raw.project_name),
    participant_name: or(raw.displayLabel, raw.participant_name),
    status: raw.status ?? null,
    started_at: or(raw.startedAt, raw.started_at),
    last_chunk_at: or(raw.lastChunkAt, raw.last_chunk_at),
    summary: raw.summary ?? null,
    matches: Array.isArray(raw.matches) ? raw.matches : [],
  };
}

function extractConversations(payload: Json, projectId: string, fallback?: string): Obj[] {
  const raw = payload.conversations;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isObj)
    .map((r) => normalizeConversation(r, projectId, fallback))
    .filter((c): c is Obj => c !== null);
}

function cacheConversations(env: ToolEnv, conversations: Obj[]) {
  for (const c of conversations)
    if (typeof c.conversation_id === "string" && c.conversation_id)
      env.turn.conversations.set(c.conversation_id, c);
}

async function resolveConversation(env: ToolEnv, conversationId: string): Promise<Obj> {
  const cached = env.turn.conversations.get(conversationId);
  if (cached) return cached;
  const p = env.ctx.projectId;
  const listed = extractConversations(
    await env.data.conversations({ limit: 1, conversationId }),
    p,
    p,
  );
  if (listed.length) {
    cacheConversations(env, listed);
    return listed[0] as Obj;
  }
  for (const c of extractConversations(await env.data.searchHome(conversationId, 20), p)) {
    if (c.conversation_id === conversationId) {
      cacheConversations(env, [c]);
      return c;
    }
  }
  throw new ValueError("Conversation not found in current project scope");
}

function keywordGuardrail(
  projectId: string,
  o: { query: string; code: string; message: string; attempts?: number; stopSearch?: boolean },
) {
  return {
    project_id: projectId,
    query: o.query,
    count: 0,
    conversations: [],
    guardrail: {
      code: o.code,
      message: o.message,
      attempts: o.attempts ?? 0,
      stop_search: o.stopSearch ?? false,
    },
  };
}

export const keywordCacheKey = (keywords: string, limit: number) =>
  `${keywords.toLowerCase()}\u0000${limit}`;
export const normalizeKeywordArgs = (args: Obj) => ({
  keywords: s(args.keywords).trim(),
  limit: clamp(typeof args.limit === "number" ? Math.trunc(args.limit) : 5, 1, 20),
});

async function resolveCanvasId(env: ToolEnv, reference: string): Promise<[string, unknown]> {
  const ref = reference.trim();
  if (!ref) throw new ValueError("canvas_id is required.");
  const canvases = (await env.data.canvases()).filter(isObj);
  if (!canvases.length) return [ref, null];
  for (const c of canvases) if (s(c.id) === ref) return [s(c.id), c.name ?? null];
  const lower = ref.toLowerCase();
  let named = canvases.filter((c) => s(c.name).trim().toLowerCase() === lower);
  if (!named.length) named = canvases.filter((c) => s(c.name).trim().toLowerCase().includes(lower));
  if (named.length === 1) {
    const c = named[0] as Obj;
    return [s(c.id), c.name ?? null];
  }
  if (named.length > 1)
    throw new ValueError(
      `Multiple canvases match ${pyStrRepr(ref)}: ${named.map((c) => s(or(c.name, c.id))).join(", ")}.`,
    );
  throw new ValueError(`No canvas matches ${pyStrRepr(ref)}. Use listCanvases first.`);
}

async function canvasLoopAction(
  env: ToolEnv,
  canvasId: string,
  action: "pause" | "resume" | "stop",
) {
  const [id, name] = await resolveCanvasId(env, canvasId);
  const loop = await env.data.canvasLoop(id, action);
  return { canvas_id: id, canvas_name: name, loop };
}

function normalizeTagList(entries: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (typeof e !== "string") continue;
    const t = e.trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

const isBlankValue = (v: unknown) =>
  v === null || v === undefined || (typeof v === "string" && !v.trim());

// ── schemas ───────────────────────────────────────────────────────────────

const int = (d: number) => z.number().int().default(d);
const optStr = (d = "") => z.string().default(d);
const empty = z.object({});

function def(name: string, group: ToolGroup, schema: z.ZodObject, run: ToolDef["run"]): ToolDef {
  const description = TOOL_DESCRIPTIONS[name];
  if (description === undefined) throw new Error(`no description for tool ${name}`);
  return { name, group, canvas: CANVAS_TOOL_NAMES.has(name), description, schema, run };
}

// ── the tools, in the Python registration order ───────────────────────────

export const TOOLS: readonly ToolDef[] = [
  def("get_project_scope", "read", empty, async (_a, env) => ({ project_id: env.ctx.projectId })),

  def(
    "findConversationsByKeywords",
    "read",
    z.object({ keywords: z.string(), limit: int(5) }),
    async (args, env) => {
      const p = env.ctx.projectId;
      const { keywords, limit } = normalizeKeywordArgs(args);
      const tokens = keywords.toLowerCase().match(/[a-z0-9]+/g) ?? [];
      if (!tokens.some((t) => t.length >= 4))
        return keywordGuardrail(p, {
          query: keywords,
          code: "LOW_SIGNAL_QUERY",
          message:
            "Low-signal keyword query. Use specific terms or listProjectConversations first.",
        });
      const cacheKey = keywordCacheKey(keywords, limit);
      const cached = env.turn.keywordCache.get(cacheKey);
      if (cached) return { ...cached, cached: true };
      const payload = await env.data.conversations({ limit, transcriptQuery: keywords });
      const conversations = extractConversations(payload, p, p);
      cacheConversations(env, conversations);
      const result = { project_id: p, query: keywords, count: conversations.length, conversations };
      env.turn.keywordCache.set(cacheKey, result);
      if (!conversations.length) {
        env.turn.consecutiveEmptyKeywordSearches++;
        if (env.turn.consecutiveEmptyKeywordSearches >= 3)
          return keywordGuardrail(p, {
            query: keywords,
            code: "NO_MATCHES_AFTER_RETRIES",
            message:
              "No matches after multiple keyword searches. " +
              "Stop repeating findConversationsByKeywords and answer from available context/evidence.",
            attempts: env.turn.consecutiveEmptyKeywordSearches,
            stopSearch: true,
          });
      } else env.turn.consecutiveEmptyKeywordSearches = 0;
      return result;
    },
  ),

  def(
    "listProjectConversations",
    "read",
    z.object({ limit: int(20), offset: int(0) }),
    async (args, env) => {
      const p = env.ctx.projectId;
      const limit = clamp(args.limit as number, 1, 100);
      const offset = Math.max(0, args.offset as number);
      const payload = await env.data.conversations({ limit, offset });
      const conversations = extractConversations(payload, p, p);
      cacheConversations(env, conversations);
      return {
        project_id: p,
        count: Math.trunc(Number(or(payload.count, conversations.length))),
        offset,
        has_more: Boolean(payload.has_more),
        conversations,
      };
    },
  ),

  def(
    "listFocusedConversations",
    "read",
    z.object({ limit: int(50), offset: int(0) }),
    async (args, env) => {
      const p = env.ctx.projectId;
      if (!env.ctx.chatId)
        return {
          project_id: p,
          total: 0,
          count: 0,
          offset: 0,
          has_more: false,
          conversations: [],
          note: "This run has no chat, so there is no focus selection.",
        };
      const limit = clamp(args.limit as number, 1, 100);
      const offset = Math.max(0, args.offset as number);
      const payload = await env.data.focusedConversations(limit, offset);
      return {
        project_id: p,
        total: Math.trunc(Number(payload.total || 0)),
        count: Math.trunc(Number(payload.count || 0)),
        offset,
        has_more: Boolean(payload.has_more),
        conversations: Array.isArray(payload.conversations) ? payload.conversations : [],
      };
    },
  ),

  def(
    "listConversationSummary",
    "read",
    z.object({ conversation_id: z.string() }),
    async (args, env) => ({
      project_id: env.ctx.projectId,
      conversation: await resolveConversation(env, args.conversation_id as string),
    }),
  ),

  def(
    "listConversationFullTranscript",
    "read",
    z.object({ conversation_id: z.string() }),
    async (args, env) => {
      const id = args.conversation_id as string;
      const conversation = await resolveConversation(env, id);
      const transcript = await env.data.transcript(id);
      return {
        project_id: env.ctx.projectId,
        conversation_id: id,
        participant_name: conversation.participant_name ?? null,
        transcript,
      };
    },
  ),

  def(
    "grepConversationSnippets",
    "read",
    z.object({ conversation_id: z.string(), query: z.string(), limit: int(8) }),
    async (args, env) => {
      const p = env.ctx.projectId;
      const id = args.conversation_id as string;
      const query = s(args.query).trim();
      if (!query) throw new ValueError("query is required");
      const limit = clamp(args.limit as number, 1, 25);
      const conversation = await resolveConversation(env, id);
      const conversations = extractConversations(
        await env.data.conversations({ limit: 1, conversationId: id, transcriptQuery: query }),
        p,
        p,
      );
      if (conversations.length) cacheConversations(env, conversations);
      let matches: unknown[] = [];
      for (const c of conversations) {
        if (c.conversation_id !== id) continue;
        if (Array.isArray(c.matches)) matches = c.matches.slice(0, limit);
        break;
      }
      return {
        project_id: p,
        conversation_id: id,
        participant_name: conversation.participant_name ?? null,
        query,
        count: matches.length,
        matches,
      };
    },
  ),

  def("listDocs", "read", empty, async (_a, env) => ({ docs: env.knowledge.listDocs() })),

  def(
    "readDoc",
    "read",
    z.object({ paths: z.array(z.string()), offset: int(1), limit: int(200) }),
    async (args, env) => {
      const paths = (args.paths as unknown[]).filter(
        (x): x is string => typeof x === "string" && Boolean(x.trim()),
      );
      if (!paths.length) throw new ValueError("Provide at least one doc path in `paths`.");
      return {
        docs: paths.map((path) => ({
          path,
          content: env.knowledge.readDoc(path, args.offset as number, args.limit as number),
        })),
      };
    },
  ),

  def("grepDocs", "read", z.object({ patterns: z.array(z.string()) }), async (args, env) => {
    const patterns = (args.patterns as unknown[]).filter(
      (x): x is string => typeof x === "string" && Boolean(x.trim()),
    );
    if (!patterns.length) throw new ValueError("Provide at least one pattern in `patterns`.");
    return {
      results: patterns.map((pattern) => ({ pattern, matches: env.knowledge.grepDocs(pattern) })),
    };
  }),

  def("readSkill", "read", z.object({ path: z.string() }), async (args, env) =>
    env.knowledge.readSkill(args.path as string),
  ),

  def("listReports", "read", empty, async (_a, env) => {
    const reports = await env.data.reports();
    return { reports, count: reports.length };
  }),

  def("readReport", "read", z.object({ report_id: z.string() }), async (args, env) => {
    const id = s(args.report_id).trim();
    if (!id) throw new ValueError("report_id is required");
    return env.data.report(id);
  }),

  def("getProjectSettings", "read", empty, async (_a, env) => {
    const current = await env.data.projectSettings();
    // Hosts think in defaults, not empty database fields.
    return Object.fromEntries(
      Object.entries(current).map(([k, v]) => [k, isBlankValue(v) ? "default" : v]),
    );
  }),

  def("getProjectTags", "read", empty, async (_a, env) => {
    const tags = await env.data.projectTags();
    return { project_id: env.ctx.projectId, count: tags.length, tags };
  }),

  def("getPortalLink", "read", empty, async (_a, env) => {
    const current = await env.data.projectSettings();
    const language = normalizePortalLanguage(current.language);
    const base = env.ctx.portalUrl.trim().replace(/\/+$/, "");
    if (!base)
      return {
        project_id: env.ctx.projectId,
        language,
        portal_link: null,
        reason:
          "Could not determine this environment's participant portal origin. " +
          "Point the host to the Overview page for the portal link and QR code instead.",
        dashboard_locations: ["Overview", "Host guide"],
      };
    return {
      project_id: env.ctx.projectId,
      language,
      portal_link: `${base}/${language}/${env.ctx.projectId}/start`,
      dashboard_locations: ["Overview", "Host guide"],
    };
  }),

  def(
    "navigateTo",
    "ui",
    z.object({ page: z.enum(DASHBOARD_PAGES), entity_id: optStr() }),
    async (args, env) => {
      const page = s(args.page).trim();
      const label = NAVIGATION_LABELS[page];
      if (label === undefined)
        throw new ValueError(
          `Unknown dashboard page: ${page}. Allowed pages: ${pyRepr(pySorted(Object.keys(NAVIGATION_LABELS)))}`,
        );
      const entity = s(args.entity_id).trim();
      return {
        type: "navigation_suggestion",
        project_id: env.ctx.projectId,
        page,
        entity_id: entity || null,
        label,
        visible_to_user: true,
      };
    },
  ),

  def(
    "proposeProjectUpdate",
    "ui",
    z.object({ changes: z.array(z.record(z.string(), z.unknown())), summary: z.string() }),
    async (args, env) => {
      const current = await env.data.projectSettings();
      const allowed = new Set(Object.keys(current));
      const normalized: Obj[] = [];
      const rejected: string[] = [];
      for (const change of args.changes as unknown[]) {
        if (!isObj(change)) continue;
        const field = s(change.field || "").trim();
        if (!allowed.has(field)) {
          rejected.push(field || "(missing field)");
          continue;
        }
        normalized.push({
          field,
          current: current[field] ?? null,
          proposed: change.value ?? null,
          reason: s(change.reason || "").trim(),
        });
      }
      if (!normalized.length)
        throw new ValueError(
          `No valid fields to propose. Editable fields: ${pyRepr(pySorted(allowed))}`,
        );
      return {
        kind: "project_update_suggestion",
        project_id: env.ctx.projectId,
        summary: s(args.summary).trim(),
        changes: normalized,
        rejected_fields: rejected,
        visible_to_user: true,
      };
    },
  ),

  def(
    "proposeTagsUpdate",
    "ui",
    z.object({
      add: z.array(z.string()).nullable().default(null),
      remove: z.array(z.string()).nullable().default(null),
      summary: optStr(),
    }),
    async (args, env) => {
      const add = normalizeTagList(args.add);
      const remove = normalizeTagList(args.remove);
      if (!add.length && !remove.length)
        throw new ValueError("Provide at least one tag to add or remove.");
      const current = await env.data.projectTags();
      const texts = current
        .filter(isObj)
        .map((t) => s(t.text ?? "").trim())
        .filter(Boolean);
      const lookup = new Set(texts.map((t) => t.toLowerCase()));
      const accepted = remove.filter((t) => lookup.has(t.toLowerCase()));
      const rejectedRemovals = remove.filter((t) => !lookup.has(t.toLowerCase()));
      if (!add.length && !accepted.length)
        throw new ValueError(
          `None of the tags to remove exist in this project. Current tags: ${pyRepr(pySorted(texts))}`,
        );
      return {
        kind: "tags_update_suggestion",
        project_id: env.ctx.projectId,
        summary: s(args.summary).trim(),
        add,
        remove: accepted,
        current_tags: texts,
        rejected_removals: rejectedRemovals,
        visible_to_user: true,
      };
    },
  ),

  def(
    "proposeCustomVerificationTopic",
    "ui",
    z.object({ label: z.string(), prompt: z.string(), reason: optStr() }),
    async (args, env) => {
      const label = s(args.label).trim();
      const prompt = s(args.prompt).trim();
      if (!label) throw new ValueError("A short label for the verification topic is required.");
      if (!prompt)
        throw new ValueError("The verification prompt (the instruction to check) is required.");
      return {
        kind: "custom_verification_topic_suggestion",
        project_id: env.ctx.projectId,
        label,
        prompt,
        reason: s(args.reason).trim(),
        visible_to_user: true,
      };
    },
  ),

  def(
    "proposeCanvas",
    "ui",
    z.object({
      name: z.string(),
      brief: z.string(),
      gather_window_minutes: int(60),
      cadence_minutes: int(5),
      expires_in_hours: int(8),
      target_canvas_id: optStr(),
      tabs: z.array(z.record(z.string(), z.unknown())).nullable().default(null),
    }),
    async (args, env) => {
      const name = s(args.name).trim();
      const brief = s(args.brief).trim();
      const cadence = args.cadence_minutes as number;
      const expires = args.expires_in_hours as number;
      if (!name) throw new ValueError("A canvas name is required.");
      if (!brief) throw new ValueError("A canvas brief is required.");
      if (cadence < 2) throw new ValueError("cadence_minutes must be at least 2.");
      if (expires > 168) throw new ValueError("expires_in_hours must be at most 168.");
      if (expires <= 0) throw new ValueError("expires_in_hours must be positive.");
      const window = clamp(
        Math.trunc((args.gather_window_minutes as number) || 60),
        1,
        60 * 24 * 14,
      );
      const expiresAt = new Date(env.now().getTime() + expires * 3_600_000);
      const payload: Obj = {
        type: "canvas_proposal",
        name,
        brief,
        gather_spec: { window_minutes: window },
        cadence_minutes: cadence,
        // Python's aware isoformat: microseconds and +00:00.
        expires_at: expiresAt.toISOString().replace(/\.(\d{3})Z$/, ".$1000+00:00"),
        visible_to_user: true,
      };
      if (args.tabs !== null) payload.tabs = args.tabs;
      if (s(args.target_canvas_id).trim()) {
        const [id, resolvedName] = await resolveCanvasId(env, s(args.target_canvas_id));
        payload.target_canvas_id = id;
        payload.target_canvas_name = resolvedName;
      }
      return payload;
    },
  ),

  def(
    "ack",
    "ui",
    z.object({ message: z.string(), plan: z.array(z.string()).nullable().default(null) }),
    async (args) => {
      const message = s(args.message).trim();
      if (!message) throw new ValueError("message is required");
      const steps = ((args.plan as string[] | null) ?? [])
        .filter((x) => x?.trim())
        .map((x) => x.trim());
      return {
        kind: "progress_update",
        update: message,
        plan: steps.slice(0, PLAN_MAX_STEPS),
        visible_to_user: true,
      };
    },
  ),

  def(
    "updatePlan",
    "ui",
    z.object({ steps: z.array(z.string()), done: z.number().int(), note: optStr() }),
    async (args) => {
      const steps = (args.steps as string[])
        .filter((x) => x?.trim())
        .map((x) => x.trim())
        .slice(0, PLAN_MAX_STEPS);
      if (!steps.length) throw new ValueError("steps are required");
      return {
        kind: "plan",
        steps,
        done: clamp(Math.trunc(args.done as number), 0, steps.length),
        note: s(args.note).trim(),
        visible_to_user: false,
      };
    },
  ),

  def(
    "sendProgressUpdate",
    "ui",
    z.object({ update: z.string(), next_steps: optStr() }),
    async (args) => {
      const update = s(args.update).trim();
      if (!update) throw new ValueError("update is required");
      return {
        kind: "progress_update",
        update,
        next_steps: s(args.next_steps).trim(),
        visible_to_user: true,
      };
    },
  ),

  def(
    "listProjectChats",
    "read",
    z.object({ limit: int(20), workspace_wide: z.boolean().default(false) }),
    async (args, env) => ({
      chats: await env.data.chats(
        clamp(args.limit as number, 1, 100),
        args.workspace_wide as boolean,
      ),
    }),
  ),

  def("readChat", "read", z.object({ chat_id: z.string() }), async (args, env) => ({
    messages: await env.data.chatMessages(args.chat_id as string, 100),
  })),

  def("getLiveConversationStatus", "read", empty, async (_a, env) => env.data.monitor(45)),

  def(
    "reachOutToDembraneSupport",
    "write",
    z.object({ message: z.string(), context: optStr() }),
    async (args, env) => {
      let result: Json;
      try {
        result = await env.data.supportRequest({
          message: args.message as string,
          page_context: (args.context as string) || null,
          message_id: env.ctx.messageId || null,
        });
      } catch {
        // Honesty over reassurance: never pretend a failed send worked.
        return {
          sent: false,
          error:
            "The request could not be logged. Tell the host plainly that " +
            "it did not go through, and give them the direct alternatives " +
            "from the Getting help page (docs: users/host/getting-help.md), " +
            "including emailing support@dembrane.com with the details.",
        };
      }
      return { sent: true, support_request_id: result.id ?? null };
    },
  ),

  def(
    "noteInsight",
    "ui",
    z.object({ kind: z.enum(INSIGHT_KINDS), content: z.string(), suggested_capability: optStr() }),
    async (args) => {
      const kind = s(args.kind).trim();
      if (!(INSIGHT_KINDS as readonly string[]).includes(kind))
        throw new ValueError("kind must be one of capability_gap, friction, wish, or praise");
      const content = s(args.content).trim();
      if (!content) throw new ValueError("content is required");
      const capability = s(args.suggested_capability).trim();
      // Consent is structural: nothing is written here. The card renders from these fields
      // and the host's own session creates the row if they send it.
      return {
        type: "agent_insight_proposal",
        mode: "proposed",
        recorded: false,
        insight_kind: kind,
        content,
        suggested_capability: capability || null,
        visible_to_user: true,
      };
    },
  ),

  def(
    "editInsight",
    "ui",
    z.object({
      insight_id: z.string(),
      content: optStr(),
      kind: optStr(),
      suggested_capability: optStr(),
    }),
    async (args, env) => {
      const id = s(args.insight_id).trim();
      if (!id) throw new ValueError("insight_id is required");
      const content = s(args.content).trim();
      const kind = s(args.kind).trim();
      const capability = s(args.suggested_capability).trim();
      if (kind && !(INSIGHT_KINDS as readonly string[]).includes(kind))
        throw new ValueError("kind must be one of capability_gap, friction, wish, or praise");
      if (!content && !kind && !capability)
        throw new ValueError(
          "Provide at least one of content, kind, or suggested_capability to edit.",
        );
      const result = await env.data.editInsight(id, {
        ...(content && { content }),
        ...(kind && { kind }),
        ...(capability && { suggested_capability: capability }),
      });
      return {
        type: "agent_insight_note",
        mode: "edited",
        recorded: true,
        agent_insight_id: or(result.id, id),
        insight_kind: or(result.kind, kind, null),
        content: or(result.content, content),
        suggested_capability: or(result.suggested_capability, null),
        visible_to_user: true,
      };
    },
  ),

  def(
    "retractInsight",
    "ui",
    z.object({ insight_id: z.string(), reason: z.string() }),
    async (args, env) => {
      const id = s(args.insight_id).trim();
      if (!id) throw new ValueError("insight_id is required");
      const reason = s(args.reason).trim();
      if (!reason) throw new ValueError("reason is required");
      const result = await env.data.retractInsight(id, reason);
      return {
        type: "agent_insight_note",
        mode: "retracted",
        recorded: true,
        agent_insight_id: or(result.id, id),
        insight_kind: or(result.kind, null),
        content: or(result.content, null),
        suggested_capability: or(result.suggested_capability, null),
        reason,
        status: or(result.status, "retracted"),
        visible_to_user: true,
      };
    },
  ),

  def("readMemory", "read", empty, async (_a, env) => {
    const payload = await env.data.memory();
    return { memories: Array.isArray(payload.memories) ? payload.memories : [] };
  }),

  def("readGoal", "read", empty, async (_a, env) => ({ ...(await env.data.projectGoal()) })),

  def("proposeGoal", "ui", z.object({ content: z.string() }), async (args, env) => {
    const content = s(args.content).trim();
    if (!content) throw new ValueError("content is required");
    return { type: "goal_proposal", content, project_id: env.ctx.projectId, visible_to_user: true };
  }),

  def("listMethodologies", "read", empty, async (_a, env) => {
    const payload = await env.data.methodologies();
    return { methodologies: Array.isArray(payload.methodologies) ? payload.methodologies : [] };
  }),

  def("listCanvases", "read", empty, async (_a, env) => ({ canvases: await env.data.canvases() })),

  def(
    "readCanvasHistory",
    "read",
    z.object({ canvas: z.string(), limit: int(30) }),
    async (args, env) => {
      const [id, name] = await resolveCanvasId(env, args.canvas as string);
      const payload = await env.data.canvasHistory(id, clamp(args.limit as number, 1, 100));
      return {
        canvas_id: id,
        canvas_name: or(name, payload.name ?? null),
        history: Array.isArray(payload.history) ? payload.history : [],
      };
    },
  ),

  def(
    "editCanvas",
    "write",
    z.object({ canvas: z.string(), instruction: z.string(), edited_html: optStr() }),
    async (args, env) => {
      const [id, name] = await resolveCanvasId(env, args.canvas as string);
      const instruction = s(args.instruction).trim();
      if (!instruction) throw new ValueError("instruction is required.");
      const canvas = await env.data.canvas(id);
      const generation = canvas.latest_generation;
      const latestHtml = isObj(generation) ? generation.content_html : null;
      if (typeof latestHtml !== "string" || !latestHtml.trim())
        throw new ValueError("This canvas has no generated HTML to edit yet.");
      const edited = s(args.edited_html).trim();
      if (!edited)
        return {
          canvas_id: id,
          canvas_name: name,
          instruction,
          latest_html: latestHtml,
          requires_edited_html: true,
        };
      const result = await env.data.editCanvas(id, instruction, edited);
      const gen = result.generation;
      return {
        canvas_id: id,
        canvas_name: name,
        status: result.status ?? null,
        generation_id: isObj(gen) ? (gen.id ?? null) : null,
      };
    },
  ),

  def(
    "addToCanvas",
    "write",
    z.object({
      canvas: z.string(),
      text: z.string(),
      target_tab: optStr("story"),
      person: optStr(),
    }),
    async (args, env) => {
      const [id, name] = await resolveCanvasId(env, args.canvas as string);
      const text = s(args.text).trim();
      if (!text) throw new ValueError("text is required.");
      const result = await env.data.addCanvasHostItem(id, {
        text,
        target_tab: args.target_tab as string,
        person: s(args.person).trim() || null,
        message_id: env.ctx.messageId || null,
      });
      return {
        canvas_id: id,
        canvas_name: name,
        status: result.status ?? null,
        host_item: result.host_item ?? null,
      };
    },
  ),

  def(
    "removeFromCanvas",
    "write",
    z.object({ canvas: z.string(), item: z.string() }),
    async (args, env) => {
      const [id, name] = await resolveCanvasId(env, args.canvas as string);
      const item = s(args.item).trim();
      if (!item) throw new ValueError("item is required.");
      const result = await env.data.removeCanvasHostItem(id, {
        item,
        message_id: env.ctx.messageId || null,
      });
      return {
        canvas_id: id,
        canvas_name: name,
        status: result.status ?? null,
        item: result.item ?? null,
      };
    },
  ),

  def("pauseCanvasLoop", "write", z.object({ canvas_id: z.string() }), (args, env) =>
    canvasLoopAction(env, args.canvas_id as string, "pause"),
  ),
  def("resumeCanvasLoop", "write", z.object({ canvas_id: z.string() }), (args, env) =>
    canvasLoopAction(env, args.canvas_id as string, "resume"),
  ),
  def("stopCanvasLoop", "write", z.object({ canvas_id: z.string() }), (args, env) =>
    canvasLoopAction(env, args.canvas_id as string, "stop"),
  ),

  def(
    "remember",
    "write",
    z.object({ content: z.string(), scope: optStr("project"), memory_key: optStr() }),
    async (args, env) => {
      const content = s(args.content).trim();
      if (!content) throw new ValueError("content is required");
      const scope = (s(args.scope) || "project").trim().toLowerCase();
      const key = s(args.memory_key).trim();
      const result = await env.data.writeMemory({ scope, content, memory_key: key || null });
      return {
        kind: "memory_saved",
        scope: result.scope ?? null,
        memory_key: key,
        action: result.action ?? null,
        id: result.id ?? null,
        visible_to_user: true,
      };
    },
  ),

  def(
    "amendMemory",
    "write",
    z.object({ memory_id: z.string(), content: z.string() }),
    async (args, env) => {
      const id = s(args.memory_id).trim();
      if (!id) throw new ValueError("memory_id is required");
      const content = s(args.content).trim();
      if (!content) throw new ValueError("content is required");
      const result = await env.data.amendMemory(id, content);
      return {
        kind: "memory_amended",
        id: result.id ?? null,
        scope: result.scope ?? null,
        action: "amended",
        visible_to_user: true,
      };
    },
  ),

  def(
    "forgetMemory",
    "write",
    z.object({ memory_id: z.string(), reason: z.string() }),
    async (args, env) => {
      const id = s(args.memory_id).trim();
      if (!id) throw new ValueError("memory_id is required");
      const reason = s(args.reason).trim();
      if (!reason) throw new ValueError("reason is required");
      const result = await env.data.forgetMemory(id);
      const forgotten = result.deleted;
      return {
        kind: "memory_forgotten",
        id,
        reason,
        forgotten: forgotten === null || forgotten === undefined ? true : Boolean(forgotten),
        visible_to_user: true,
      };
    },
  ),
];

/** The tools one turn may call: canvas tools exist only when the project has canvas on. */
export function toolsFor(canvasEnabled: boolean): ToolDef[] {
  return TOOLS.filter((t) => canvasEnabled || !t.canvas);
}
