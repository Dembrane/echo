import type { AgentContext } from "./context";
import type { Param } from "./pyargs";
import type { Row } from "./storage";
import { CONVERSATION_SORTS, type ConversationSort } from "./toolkit";
import * as T from "./tools";

/**
 * The tool catalogue: names, descriptions, parameters and annotations exactly as the
 * Python server published them (connected agents cache tools/list), plus how each one runs
 * and what its audit row records. REST routes and MCP calls both run from here.
 */

type Annotations = Record<string, boolean>;
// Every tool touches dembrane data only, hence openWorldHint false throughout.
const READ: Annotations = { openWorldHint: false, readOnlyHint: true };
const WRITE: Annotations = {
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
  readOnlyHint: false,
};

export interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly params: readonly Param[];
  readonly annotations: Annotations;
  /** The audit row's params: never message bodies, only their size. */
  readonly audit: (a: Row) => Row;
  readonly run: (d: T.ToolDeps, ctx: AgentContext, a: Row) => Promise<Row>;
}

const str = (name: string): Param => ({ name, kind: "str" });
const optstr = (name: string): Param => ({ name, kind: "optstr" });
const optbool = (name: string): Param => ({ name, kind: "optbool" });
const int = (name: string, def: number): Param => ({ name, kind: "int", default: def });
const FORMAT: Param = {
  name: "format",
  kind: "literal",
  values: ["concise", "detailed"],
  default: "concise",
};

const S = (v: unknown) => v as string;
const N = (v: unknown) => v as number;
const O = (v: unknown) => v as string | null;
/** Python's (s or "")[:200]: the first 200 code points. */
const cut = (v: unknown) =>
  Array.from((v as string | null) ?? "")
    .slice(0, 200)
    .join("");

export const TOOLS: readonly ToolDef[] = [
  {
    name: "dembrane_whoami",
    description:
      "Who you are acting as and everywhere this grant can reach. Returns the person's " +
      "name and email, the granted scopes, the server build version, and every " +
      "organisation in the grant with your role there and its workspaces (id, name, " +
      "role, tier). Call this first in a session. An organisation with " +
      "agent_access_enabled false is named but its workspaces are hidden and every call " +
      "into it fails until an admin switches access back on. Costs nothing against the " +
      "free-tier budget.",
    params: [],
    annotations: READ,
    audit: () => ({}),
    run: (d, ctx) => T.whoami(d, ctx),
  },
  {
    name: "dembrane_find_projects",
    description:
      "Find projects by name across every workspace this grant can reach. Returns each " +
      "project's id and name with its workspace and organisation names, most recently " +
      "updated first. Leave query empty for the most recent projects; pass workspace_id " +
      "to look in one workspace only. Use this to get a project_id before any project " +
      "tool: there is no separate workspace or project listing. Matching is " +
      "case-insensitive on the name and every word must match. At most 200 results; " +
      "costs nothing against the free-tier budget.",
    params: [optstr("query"), optstr("workspace_id"), int("limit", 50)],
    annotations: READ,
    audit: (a) => ({ query: cut(a.query), workspace_id: a.workspace_id, limit: a.limit }),
    run: (d, ctx, a) =>
      T.findProjects(d, ctx, {
        query: O(a.query),
        workspace_id: O(a.workspace_id),
        limit: N(a.limit),
      }),
  },
  {
    name: "dembrane_get_project",
    description:
      "One project's settings: name, language, context, whether new conversations are " +
      "allowed, and its workspace and organisation names. Use it when you need the " +
      "project's configuration. For its conversations call dembrane_list_conversations; " +
      "for what was said in them call dembrane_search_transcripts.",
    params: [str("project_id")],
    annotations: READ,
    audit: (a) => ({ project_id: a.project_id }),
    run: (d, ctx, a) => T.getProject(d, ctx, S(a.project_id)),
  },
  {
    name: "dembrane_update_project",
    description:
      "Change a project's settings. Needs the write scope, and the person you act as " +
      "must be allowed to edit the project. Only the fields you pass are changed; pass " +
      "at least one. Fields: name, context (the description hosts and participants " +
      "see), language, is_conversation_allowed, default_conversation_title, " +
      "default_conversation_description, default_conversation_finish_text. Returns the " +
      "project as dembrane_get_project would.",
    params: [
      str("project_id"),
      optstr("name"),
      optstr("context"),
      optstr("language"),
      optbool("is_conversation_allowed"),
      optstr("default_conversation_title"),
      optstr("default_conversation_description"),
      optstr("default_conversation_finish_text"),
    ],
    annotations: WRITE,
    // Over MCP a null means "leave as is", so only the fields given a value are changed.
    audit: (a) => ({ project_id: a.project_id, fields: Object.keys(updateFields(a)).sort() }),
    run: (d, ctx, a) => T.updateProject(d, ctx, S(a.project_id), updateFields(a)),
  },
  {
    name: "dembrane_list_project_webhooks",
    description:
      "The webhooks configured on a project: id, name, URL, events and status, never " +
      "the secret. Needs the workspace:webhooks permission, which most people do not " +
      "have, so expect 404 unless you act as a workspace admin on a plan with webhooks.",
    params: [str("project_id")],
    annotations: READ,
    audit: (a) => ({ project_id: a.project_id }),
    run: (d, ctx, a) => T.listProjectWebhooks(d, ctx, S(a.project_id)),
  },
  {
    name: "dembrane_list_conversations",
    description:
      "A page of a project's conversations, newest first by default, without " +
      "transcripts. Concise (the default) returns id, participant_name, title, " +
      "created_at, duration in seconds and status (live, processing or done); " +
      "format=detailed adds the summary, tags and whether the conversation is locked. " +
      "search matches participant name, email, title and summary; created_after and " +
      "created_before are ISO 8601 bounds; sort is one of -created_at, created_at, " +
      "-updated_at, updated_at, -duration, duration. Page with offset while has_more is " +
      "true; limit is at most 500. To find conversations by what was said inside them " +
      "use dembrane_search_transcripts instead.",
    params: [
      str("project_id"),
      optstr("search"),
      optstr("created_after"),
      optstr("created_before"),
      int("limit", 100),
      int("offset", 0),
      { name: "sort", kind: "literal", values: CONVERSATION_SORTS, default: "-created_at" },
      FORMAT,
    ],
    annotations: READ,
    audit: (a) => ({
      project_id: a.project_id,
      search: a.search,
      created_after: a.created_after,
      created_before: a.created_before,
      limit: a.limit,
      offset: a.offset,
      sort: a.sort,
      format: a.format,
    }),
    run: (d, ctx, a) =>
      T.listConversations(d, ctx, S(a.project_id), {
        search: O(a.search),
        created_after: O(a.created_after),
        created_before: O(a.created_before),
        limit: N(a.limit),
        offset: N(a.offset),
        sort: a.sort as ConversationSort,
        format: a.format as T.ResultFormat,
      }),
  },
  {
    name: "dembrane_search_transcripts",
    description:
      "Find the conversations in a project whose transcript contains the words in " +
      "query, with up to 3 snippets each. Returns the words actually searched (tokens), " +
      "the matching conversations with the most recent speech first, and has_more for " +
      "paging with offset. Words shorter than 4 letters are dropped and at most 4 " +
      "distinct words are used, any one of them matching; two to four specific words " +
      "work best. Use this to locate where a topic came up, then " +
      "dembrane_read_transcript on the conversations that matter. A locked conversation " +
      "appears without snippets. At most 100 per page.",
    params: [str("project_id"), str("query"), int("limit", 20), int("offset", 0)],
    annotations: READ,
    audit: (a) => ({
      project_id: a.project_id,
      query: cut(a.query),
      limit: a.limit,
      offset: a.offset,
    }),
    run: (d, ctx, a) =>
      T.searchTranscripts(d, ctx, S(a.project_id), S(a.query), N(a.limit), N(a.offset)),
  },
  {
    name: "dembrane_grep_conversation",
    description:
      "Snippets from one conversation's transcript around the words in query, in " +
      "speaking order, each with its chunk id and timestamp. Use it to check exact " +
      "wording or to find where in a long conversation something was said; to search a " +
      "whole project use dembrane_search_transcripts. Words shorter than 4 letters are " +
      "dropped. At most 50 matches. A locked conversation returns no matches.",
    params: [str("conversation_id"), str("query"), int("max_matches", 10)],
    annotations: READ,
    audit: (a) => ({
      conversation_id: a.conversation_id,
      query: cut(a.query),
      max_matches: a.max_matches,
    }),
    run: (d, ctx, a) =>
      T.grepConversation(d, ctx, S(a.conversation_id), S(a.query), N(a.max_matches)),
  },
  {
    name: "dembrane_read_transcript",
    description:
      "One conversation's transcript as a page of chunks in speaking order. Each chunk " +
      "has a timestamp and its text; format=detailed adds the chunk id. offset and " +
      "limit count chunks, limit at most 200; total and has_more say when to page. This " +
      "is the only way to read what was said: take one page at a time and page while " +
      "has_more is true rather than asking for everything at once. A locked " +
      "conversation returns its chunks without text and transcript_locked true; that is " +
      "the workspace's plan cap, not an error. For metadata only, " +
      "dembrane_get_conversation.",
    params: [str("conversation_id"), int("offset", 0), int("limit", 50), FORMAT],
    annotations: READ,
    audit: (a) => ({
      conversation_id: a.conversation_id,
      offset: a.offset,
      limit: a.limit,
      format: a.format,
    }),
    run: (d, ctx, a) =>
      T.readTranscript(
        d,
        ctx,
        S(a.conversation_id),
        N(a.offset),
        N(a.limit),
        a.format as T.ResultFormat,
      ),
  },
  {
    name: "dembrane_get_conversation",
    description:
      "One conversation's metadata: participant, title, summary, tags, status, " +
      "duration, chunk count and whether it is locked. Never the transcript: call " +
      "dembrane_read_transcript for the text. Use this to check what a conversation is " +
      "about before reading it, or to fetch its summary and tags.",
    params: [str("conversation_id")],
    annotations: READ,
    audit: (a) => ({ conversation_id: a.conversation_id }),
    run: (d, ctx, a) => T.getConversation(d, ctx, S(a.conversation_id)),
  },
  {
    name: "dembrane_report_issue",
    description:
      "Tell the dembrane team something is wrong: a transcript that looks broken, a " +
      "tool that errored, data that does not add up. Files a support ticket in the " +
      "person's name and returns its id. Name the project_id or conversation_id when " +
      "you have one so the team can look. Not for missing features: that is " +
      "dembrane_request_tool.",
    params: [str("message"), optstr("project_id"), optstr("conversation_id")],
    annotations: WRITE,
    audit: (a) => ({
      project_id: a.project_id,
      conversation_id: a.conversation_id,
      chars: Array.from(S(a.message ?? "")).length,
    }),
    run: (d, ctx, a) => T.reportIssue(d, ctx, S(a.message), O(a.project_id), O(a.conversation_id)),
  },
  {
    name: "dembrane_request_tool",
    description:
      "Ask the dembrane team for a tool that does not exist yet. Give it a short name, " +
      "describe in plain words what you were trying to do, and give one example call " +
      "you wish had worked. Files the request and returns its id. Use it when no listed " +
      "tool fits; for something broken use dembrane_report_issue.",
    params: [str("name"), str("description"), optstr("example")],
    annotations: WRITE,
    audit: (a) => ({ name: a.name, chars: Array.from(S(a.description ?? "")).length }),
    run: (d, ctx, a) => T.requestTool(d, ctx, S(a.name), S(a.description), O(a.example)),
  },
  {
    name: "dembrane_read_doc",
    description:
      "Read one page of the dembrane user documentation by path, line-numbered. Returns " +
      "up to 400 lines from offset (1-based); the text ends with the next offset when " +
      "there is more. Get paths from dembrane_search_docs. Public content about how " +
      "dembrane works for hosts and participants, not about the person's data.",
    params: [str("path"), int("offset", 1), int("limit", 400)],
    annotations: READ,
    audit: (a) => ({ path: a.path, offset: a.offset, limit: a.limit }),
    run: (d, _ctx, a) => T.readDoc(d, S(a.path), N(a.offset), N(a.limit)),
  },
  {
    name: "dembrane_search_docs",
    description:
      "Search the dembrane user documentation, or list it. With pattern (a " +
      "case-insensitive regular expression) returns the matching lines with their page " +
      "path, title and line number, at most 50. Without pattern returns the page index: " +
      "every path with its title. Use it for questions about how dembrane works " +
      "(projects, conversations, participant links, plans), then dembrane_read_doc on " +
      "a page. It does not search the person's conversations: that is " +
      "dembrane_search_transcripts.",
    params: [optstr("pattern"), int("max_results", 50)],
    annotations: READ,
    audit: (a) => ({ pattern: cut(a.pattern), max_results: a.max_results }),
    run: (d, _ctx, a) => T.searchDocs(d, O(a.pattern), N(a.max_results)),
  },
  {
    name: "dembrane_list_tools",
    description:
      "Every tool on this server with a one-line description, whether it is read-only, " +
      "and the server build version. Call it when a tool name you remember is rejected " +
      "or when you reconnect after a long session: the set changes between builds. " +
      "Same names as tools/list.",
    params: [],
    annotations: READ,
    audit: () => ({}),
    run: async (d) => catalogue(d.buildVersion),
  },
];

function updateFields(a: Row): Row {
  const out: Row = {};
  for (const f of T.PROJECT_UPDATE_FIELDS) if (a[f] !== null && a[f] !== undefined) out[f] = a[f];
  return out;
}

/** The first sentence of a description, whitespace collapsed. */
function oneLine(description: string): string {
  const t = description.split(/\s+/).filter(Boolean).join(" ");
  const at = t.indexOf(". ");
  return at < 0 ? t : `${t.slice(0, at)}.`;
}

/** Every tool with its one-line description and read-only flag, for agents that reconnect. */
export function catalogue(buildVersion: string) {
  return {
    build_version: buildVersion,
    tools: [...TOOLS]
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((t) => ({
        name: t.name,
        description: oneLine(t.description),
        read_only: Boolean(t.annotations.readOnlyHint),
      })),
  };
}

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
