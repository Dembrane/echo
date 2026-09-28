// The MCP endpoint (/api/mcp): the streamable HTTP transport's answers, the JSON-RPC
// protocol, and a tools/call for every tool with its refusals and argument errors. The
// tool answer's text is compared byte for byte, because agents read that text.
import { AGENT_GRANTS, bearer, ORG_A_OFF, ORG_B_ON, TOKENS } from "../agent-setup";
import { conversations, projects } from "../fixtures";
import { type Scenario, scenarios } from "../runner/scenario";

const { p1, p2, p3 } = projects;
const { c1, c2, c3 } = conversations;
const MCP = "/api/mcp";
const ACCEPT = { accept: "application/json, text/event-stream" };
const ignoreFields = ["duration_ms"];
const C3_LOCKED = `update conversation set is_over_cap = true where id = '${conversations.c3}'`;

type As = keyof typeof TOKENS;
function rpc(name: string, who: As | null, body: unknown, extra: Partial<Scenario> = {}): Scenario {
  return {
    name: `mcp: ${name}`,
    as: "anonymous",
    method: "POST",
    path: MCP,
    body,
    ignoreFields,
    ...extra,
    setup: [...AGENT_GRANTS, ...((extra.setup as string[] | undefined) ?? [])],
    headers: {
      ...ACCEPT,
      ...(who && bearer(TOKENS[who])),
      ...((extra.headers as Record<string, string> | undefined) ?? {}),
    },
  };
}

let seq = 0;
const tool = (
  name: string,
  who: As,
  toolName: string,
  args: Record<string, unknown> | undefined,
  extra: Partial<Scenario> = {},
) =>
  rpc(
    name,
    who,
    {
      jsonrpc: "2.0",
      id: ++seq,
      method: "tools/call",
      params: { name: toolName, ...(args !== undefined && { arguments: args }) },
    },
    extra,
  );

export default scenarios([
  // ── transport and auth ───────────────────────────────────────────────
  rpc(
    "no token",
    null,
    { jsonrpc: "2.0", id: 1, method: "ping" },
    { responseHeaders: ["www-authenticate"] },
  ),
  rpc(
    "unknown token",
    null,
    { jsonrpc: "2.0", id: 1, method: "ping" },
    { headers: bearer("dbr_at_nope"), responseHeaders: ["www-authenticate"] },
  ),
  rpc("revoked grant", "revoked", { jsonrpc: "2.0", id: 1, method: "ping" }),
  rpc("expired token", "expiredToken", { jsonrpc: "2.0", id: 1, method: "ping" }),
  rpc("ping", "alice", { jsonrpc: "2.0", id: 1, method: "ping" }),
  rpc("ping string id", "alice", { jsonrpc: "2.0", id: "s-1", method: "ping" }),
  rpc("initialize", "alice", {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "p", version: "1" },
    },
  }),
  rpc("initialize latest", "alice", {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "p", version: "1" },
    },
  }),
  rpc("initialize unknown version", "alice", {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "1999-01-01",
      capabilities: {},
      clientInfo: { name: "p", version: "1" },
    },
  }),
  rpc("notification", "alice", { jsonrpc: "2.0", method: "notifications/initialized" }),
  rpc("response message", "alice", { jsonrpc: "2.0", id: 9, result: {} }),
  rpc("unknown method", "alice", { jsonrpc: "2.0", id: 1, method: "nope/x" }),
  rpc("logging not offered", "alice", {
    jsonrpc: "2.0",
    id: 1,
    method: "logging/setLevel",
    params: { level: "info" },
  }),
  rpc("prompts list", "alice", { jsonrpc: "2.0", id: 1, method: "prompts/list" }),
  rpc("prompts get", "alice", {
    jsonrpc: "2.0",
    id: 1,
    method: "prompts/get",
    params: { name: "x" },
  }),
  rpc("resources list", "alice", { jsonrpc: "2.0", id: 1, method: "resources/list" }),
  rpc("resource templates", "alice", { jsonrpc: "2.0", id: 1, method: "resources/templates/list" }),
  rpc("resources read", "alice", {
    jsonrpc: "2.0",
    id: 1,
    method: "resources/read",
    params: { uri: "x://y" },
  }),
  rpc("batch refused", "alice", [{ jsonrpc: "2.0", id: 1, method: "ping" }]),
  rpc("not an object", "alice", "x"),
  rpc("missing jsonrpc", "alice", { id: 8, method: "ping" }),
  rpc("invalid json", "alice", undefined, {
    raw: "{nope",
    headers: { "content-type": "application/json" },
  }),
  rpc("empty body", "alice", undefined, {
    raw: "",
    headers: { "content-type": "application/json" },
  }),
  rpc("wrong content type", "alice", undefined, { urlencoded: { a: "1" } }),
  rpc(
    "not acceptable",
    "alice",
    { jsonrpc: "2.0", id: 1, method: "ping" },
    { headers: { accept: "text/html" } },
  ),
  rpc(
    "wildcard accept",
    "alice",
    { jsonrpc: "2.0", id: 1, method: "ping" },
    { headers: { accept: "*/*" } },
  ),
  {
    name: "mcp: delete has no session",
    as: "anonymous",
    method: "DELETE",
    path: MCP,
    setup: [...AGENT_GRANTS],
    headers: bearer(TOKENS.alice),
  },
  {
    name: "mcp: get needs event-stream",
    as: "anonymous",
    method: "GET",
    path: MCP,
    setup: [...AGENT_GRANTS],
    headers: { ...bearer(TOKENS.alice), accept: "application/json" },
  },

  // ── catalogue ────────────────────────────────────────────────────────
  rpc("tools list", "alice", { jsonrpc: "2.0", id: 1, method: "tools/list" }),
  rpc("tools list with cursor", "alice", {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: { cursor: "abc" },
  }),
  tool("list tools", "alice", "dembrane_list_tools", {}),
  tool("call without arguments", "alice", "dembrane_whoami", undefined),
  rpc("call without name", "alice", { jsonrpc: "2.0", id: 1, method: "tools/call", params: {} }),
  tool("unknown tool", "alice", "dembrane_delete_everything", { a: 1, b: 2 }),

  // ── identity and discovery ───────────────────────────────────────────
  tool("whoami", "alice", "dembrane_whoami", {}),
  tool("whoami guest", "bob", "dembrane_whoami", {}, { setup: [ORG_B_ON] }),
  tool("whoami org off", "alice", "dembrane_whoami", {}, { setup: [ORG_A_OFF] }),
  tool("find", "alice", "dembrane_find_projects", { query: "city" }),
  tool("find limit clamps", "alice", "dembrane_find_projects", { limit: 0 }),
  tool("find limit text", "alice", "dembrane_find_projects", { limit: "abc" }),
  tool("find limit as string", "alice", "dembrane_find_projects", { limit: "1" }),
  tool("find query json null", "alice", "dembrane_find_projects", { query: "null" }),
  tool("find wrong types", "alice", "dembrane_find_projects", { query: 5, workspace_id: [1] }),

  // ── projects ─────────────────────────────────────────────────────────
  tool("get project", "alice", "dembrane_get_project", { project_id: p1 }),
  tool("get project missing arg", "alice", "dembrane_get_project", {}),
  tool("get project other tenant", "alice", "dembrane_get_project", { project_id: p3 }),
  tool("get project not a uuid", "alice", "dembrane_get_project", { project_id: "abc" }),
  tool("get project org not in grant", "aliceOrgB", "dembrane_get_project", { project_id: p1 }),
  tool("get project org off", "bob", "dembrane_get_project", { project_id: p3 }),
  tool("update project", "alice", "dembrane_update_project", {
    project_id: p1,
    name: "Renamed over MCP",
    context: null,
    is_conversation_allowed: "false",
  }),
  tool("update project nothing", "alice", "dembrane_update_project", {
    project_id: p1,
    name: null,
  }),
  tool("update project read-only", "aliceRead", "dembrane_update_project", {
    project_id: p1,
    name: "x",
  }),
  tool("update project bad bool", "alice", "dembrane_update_project", {
    project_id: p1,
    is_conversation_allowed: "maybe",
  }),
  tool("update project private as external", "bob", "dembrane_update_project", {
    project_id: p2,
    name: "x",
  }),
  tool("webhooks", "alice", "dembrane_list_project_webhooks", { project_id: p1 }),
  tool(
    "webhooks free tier",
    "bob",
    "dembrane_list_project_webhooks",
    { project_id: p3 },
    {
      setup: [ORG_B_ON],
    },
  ),

  // ── conversations ────────────────────────────────────────────────────
  tool("list conversations", "alice", "dembrane_list_conversations", { project_id: p1 }),
  tool("list conversations detailed", "alice", "dembrane_list_conversations", {
    project_id: p1,
    format: "detailed",
    sort: "-duration",
  }),
  tool("list conversations negative page", "alice", "dembrane_list_conversations", {
    project_id: p1,
    limit: -5,
    offset: -2,
  }),
  tool("list conversations bad literal", "alice", "dembrane_list_conversations", {
    project_id: p1,
    format: "full",
    sort: 3,
  }),
  tool("list conversations bad bound", "alice", "dembrane_list_conversations", {
    project_id: p1,
    created_before: "2026-13-01",
  }),
  tool(
    "list conversations locked",
    "bob",
    "dembrane_list_conversations",
    {
      project_id: p3,
      format: "detailed",
    },
    { setup: [ORG_B_ON, C3_LOCKED] },
  ),
  tool("search transcripts", "alice", "dembrane_search_transcripts", {
    project_id: p1,
    query: "Charging, buses & grid!",
  }),
  tool("search transcripts page", "alice", "dembrane_search_transcripts", {
    project_id: p1,
    query: "charging cycle",
    limit: 1,
    offset: 1,
  }),
  tool("search transcripts short", "alice", "dembrane_search_transcripts", {
    project_id: p1,
    query: "a an the",
  }),
  tool("search transcripts blank", "alice", "dembrane_search_transcripts", {
    project_id: p1,
    query: "  ",
  }),
  tool("search transcripts missing", "alice", "dembrane_search_transcripts", {}),
  tool(
    "search transcripts locked",
    "bob",
    "dembrane_search_transcripts",
    {
      project_id: p3,
      query: "kickoff",
    },
    { setup: [ORG_B_ON, C3_LOCKED] },
  ),
  tool("grep", "alice", "dembrane_grep_conversation", { conversation_id: c1, query: "grid" }),
  tool("grep clamps", "alice", "dembrane_grep_conversation", {
    conversation_id: c1,
    query: "charging buses grid",
    max_matches: 500,
  }),
  tool("grep other tenant", "rita", "dembrane_grep_conversation", {
    conversation_id: c1,
    query: "grid",
  }),
  tool("read transcript", "alice", "dembrane_read_transcript", { conversation_id: c1 }),
  tool("read transcript detailed", "alice", "dembrane_read_transcript", {
    conversation_id: c1,
    format: "detailed",
    offset: 2,
    limit: 5,
  }),
  tool("read transcript live", "alice", "dembrane_read_transcript", { conversation_id: c2 }),
  tool(
    "read transcript locked",
    "bob",
    "dembrane_read_transcript",
    {
      conversation_id: c3,
    },
    { setup: [ORG_B_ON, C3_LOCKED] },
  ),
  tool("get conversation", "alice", "dembrane_get_conversation", { conversation_id: c1 }),
  tool("get conversation live", "alice", "dembrane_get_conversation", { conversation_id: c2 }),
  tool("get conversation missing", "alice", "dembrane_get_conversation", {
    conversation_id: "c1000000-0000-4000-8000-00000000dead",
  }),

  // ── reporting and docs ───────────────────────────────────────────────
  tool("report issue", "alice", "dembrane_report_issue", {
    message: "Transcript cut off",
    conversation_id: c1,
  }),
  tool("report issue blank", "alice", "dembrane_report_issue", { message: " " }),
  tool("report issue other tenant", "alice", "dembrane_report_issue", {
    message: "x",
    project_id: p3,
  }),
  tool("request tool", "alice", "dembrane_request_tool", {
    name: "export",
    description: "Export conversations to CSV",
    example: "dembrane_export(project_id)",
  }),
  tool("request tool missing description", "alice", "dembrane_request_tool", { name: "x" }),
  tool("search docs index", "alice", "dembrane_search_docs", {}),
  tool("search docs", "alice", "dembrane_search_docs", { pattern: "consent", max_results: 3 }),
  tool("read doc", "alice", "dembrane_read_doc", { path: "users/index.md", limit: 5 }),
  tool("read doc missing", "alice", "dembrane_read_doc", { path: "missing.md" }),
]);
