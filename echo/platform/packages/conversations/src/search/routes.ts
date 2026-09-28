import { type Env, requireUser } from "@dembrane/http";
import { isoTimestamp, p, pydanticIso } from "@dembrane/legacy-shape";
import { projectAllows } from "@dembrane/projects";
import { Hono } from "hono";
import type { ConversationsDeps } from "../deps";
import { searchStorage } from "./storage";

const { required, optional, str, int } = p;

const SEARCH_LIMIT = { name: "home_search", capacity: 40, windowSeconds: 60 };

const time = (v: string | null | undefined) => (v ? pydanticIso(isoTimestamp(v) ?? v) : null);

function status(c: { is_finished: boolean | null; is_all_chunks_transcribed: boolean | null }) {
  if (!c.is_finished) return "live";
  if (!c.is_all_chunks_transcribed) return "processing";
  return "done";
}

function displayLabel(c: {
  id: string;
  participant_name: string | null;
  participant_email: string | null;
}) {
  if (c.participant_name?.trim()) return c.participant_name;
  if (c.participant_email?.trim()) return c.participant_email;
  return `Conversation ${c.id.slice(0, 6)}`;
}

/** At most 280 characters of transcript, cut with an ellipsis as before. */
function excerpt(text: string | null): string | null {
  if (!text) return text;
  const chars = [...text];
  return chars.length > 280 ? `${chars.slice(0, 277).join("")}…` : text;
}

/**
 * GET /api/home/search: the dashboard's command palette over projects, conversations,
 * transcripts and chats. Rows are read broadly, then kept only where the caller may
 * read the project, staff included, so a hit never 404s on click. M-5: the Python API
 * kept any role on the project, workspace billing included; project:read decides now.
 */
export function searchRoutes(d: ConversationsDeps) {
  const store = searchStorage(d.db);
  const app = new Hono<Env>();

  app.get("/api/home/search", async (c) => {
    const who = requireUser(c);
    const { query } = await p.validate(c.req, {
      query: {
        query: required(str({ min: 1, max: 120 })),
        limit: optional(int({ ge: 1, le: 20 }), 5),
      },
    });
    await d.limiter.check(SEARCH_LIMIT, who.directusUserId);
    const empty = { projects: [], conversations: [], transcripts: [], chats: [] };
    const term = query.query.trim();
    if (!term) return c.json(empty);
    const limit = Math.max(1, Math.min(query.limit, 25));
    const fetch = limit * 3;
    const [projects, conversations, chunks, chats] = await Promise.all([
      store.projects(term, fetch),
      store.conversations(term, fetch),
      store.chunks(term, fetch),
      store.chats(term, fetch),
    ]);
    // Not onboarded: nothing is reachable, answered as empty rather than an error.
    if (!who.appUserId) return c.json(empty);

    const allowed = new Map<string, boolean>();
    const can = async (projectId: string | null) => {
      if (!projectId) return false;
      if (!allowed.has(projectId))
        allowed.set(projectId, await projectAllows(d.access, who, projectId, "project:read"));
      return allowed.get(projectId) as boolean;
    };
    async function scope<T>(rows: T[], of: (r: T) => string | null): Promise<T[]> {
      const out: T[] = [];
      for (const r of rows) {
        if (await can(of(r))) {
          out.push(r);
          if (out.length >= limit) break;
        }
      }
      return out;
    }

    const ps = await scope(projects, (r) => r.id);
    const cs = await scope(conversations, (r) => r.project_id);
    const ks = await scope(chunks, (r) => r.project_id);
    const hs = await scope(chats, (r) => r.project_id);

    return c.json({
      projects: ps.map((r) => ({
        id: r.id,
        name: r.name,
        workspaceId: r.workspace_id,
        lastActivityAt: time(r.updated_at),
        conversationsCount: Number(r.conversations_count ?? 0),
      })),
      conversations: cs.map((r) => ({
        id: r.id,
        projectId: r.project_id,
        projectName: r.project_name,
        workspaceId: r.workspace_id,
        displayLabel: displayLabel(r),
        status: status(r),
        startedAt: time(r.created_at),
        lastChunkAt: time(r.last_chunk?.timestamp ?? r.last_chunk?.created_at ?? null),
        summary: r.summary,
      })),
      transcripts: ks.map((r) => ({
        id: r.id,
        conversationId: r.conversation_id,
        conversationLabel: r.participant_name,
        projectId: r.project_id,
        workspaceId: r.workspace_id,
        excerpt: excerpt(r.transcript),
        timestamp: time(r.timestamp ?? r.created_at),
      })),
      chats: hs.map((r) => ({
        id: r.id,
        projectId: r.project_id,
        projectName: r.project_name,
        workspaceId: r.workspace_id,
        name: r.name,
      })),
    });
  });

  return app;
}
