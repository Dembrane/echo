import { PlatformError } from "@dembrane/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { type AgentContext, auditStatus } from "./context";
import { jsonErrorText } from "./jsonerror";
import { ArgumentError, inputSchema, pyJson, pyRepr, validateArgs } from "./pyargs";
import { TOOL_BY_NAME, TOOLS } from "./registry";
import type { Row } from "./storage";
import type { ToolDeps } from "./tools";

/**
 * The MCP server: one tool per registry entry, stateless streamable HTTP with JSON
 * responses, so any API instance answers any call. The official SDK runs the JSON-RPC
 * protocol (initialize, dispatch, notifications); a thin front in `handleMcpPost`
 * reproduces the Python transport's answers to malformed requests first, because the SDK
 * words those differently and connected clients were built against the Python server.
 */

export const INSTRUCTIONS =
  "You are connected to dembrane as one person, limited to the organisations they " +
  "chose: you see what they see and nothing more. Start with dembrane_whoami; it names " +
  "the person, the scopes, and every organisation and workspace you can reach. Then " +
  "dembrane_find_projects with part of a project's name to get a project_id. To learn " +
  "what was said, call dembrane_search_transcripts on the project, then " +
  "dembrane_read_transcript on the conversations that matter, paging with offset; " +
  "dembrane_grep_conversation finds exact wording in one conversation. " +
  "dembrane_list_conversations is the roster of a project (who, when, how long) and " +
  "dembrane_get_conversation the metadata of one; neither returns transcript text. " +
  "Every id is a UUID; pass ids between tools verbatim. Answers are capped at about " +
  "15k tokens: a truncated answer says so and how to page or narrow. For how dembrane " +
  "itself works, dembrane_search_docs then dembrane_read_doc. If something looks " +
  "wrong, dembrane_report_issue; if you need a tool that does not exist, " +
  "dembrane_request_tool; if a name you remember is rejected, dembrane_list_tools.";

/** About 15k tokens. Above this an answer is cut, with a note, never dropped. */
const MAX_RESULT_CHARS = 60_000;

const TOOL_LIST = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: inputSchema(t.name, t.params),
  outputSchema: { type: "object", additionalProperties: true, title: `${t.name}DictOutput` },
  annotations: t.annotations,
}));

/** Methods the Python server answered; anything else is "Method not found" with the method as data. */
const METHODS = new Set([
  "initialize",
  "ping",
  "tools/list",
  "tools/call",
  "prompts/list",
  "prompts/get",
  "resources/list",
  "resources/read",
  "resources/templates/list",
]);

// ── answer size ────────────────────────────────────────────────────────

/** Length of Python's json.dumps(value, ensure_ascii=False): ", " and ": " separators, code points. */
function pySize(v: unknown): number {
  const walk = (x: unknown, key?: string): string => {
    if (x === null || x === undefined) return "null";
    if (typeof x === "number")
      return key === "duration" && Number.isInteger(x) ? `${x}.0` : JSON.stringify(x);
    if (typeof x === "boolean") return x ? "true" : "false";
    if (typeof x === "string") return JSON.stringify(x);
    if (Array.isArray(x)) return `[${x.map((i) => walk(i)).join(", ")}]`;
    return `{${Object.entries(x as Row)
      .map(([k, i]) => `${JSON.stringify(k)}: ${walk(i, k)}`)
      .join(", ")}}`;
  };
  return Array.from(walk(v)).length;
}

/**
 * Keeps one answer under MAX_RESULT_CHARS. The bulk of every answer is one list; when the
 * whole is over the cap that list is cut to the prefix that fits, `truncated` is set,
 * `has_more` where the tool pages, and `note` says how to continue. At least one item is
 * kept, and an answer with no list to cut goes out whole: over budget beats silently short.
 */
export function fit(result: Row): Row {
  if (pySize(result) <= MAX_RESULT_CHARS) return result;
  const lists = Object.entries(result).filter(([, v]) => Array.isArray(v) && v.length) as [
    string,
    unknown[],
  ][];
  if (!lists.length) return result;
  let [key, items] = lists[0] as [string, unknown[]];
  for (const [k, v] of lists)
    if (pySize(v) > pySize(items)) {
      key = k;
      items = v;
    }
  const shell = { ...result, [key]: [], truncated: true, has_more: true, note: " ".repeat(300) };
  const room = MAX_RESULT_CHARS - pySize(shell);
  const kept: unknown[] = [];
  let used = 0;
  for (const item of items) {
    const size = pySize(item) + 2;
    if (kept.length && used + size > room) break;
    kept.push(item);
    used += size;
  }
  let note =
    `Truncated: ${kept.length} of ${items.length} ${key} shown because the full answer was ` +
    `over the ${MAX_RESULT_CHARS.toLocaleString("en-US")}-character cap. `;
  note +=
    "offset" in result
      ? `Call again with offset=${Number(result.offset ?? 0) + kept.length} for the rest, or pass a smaller limit.`
      : "Pass a smaller limit or a narrower query.";
  const out: Row = { ...result, [key]: kept, truncated: true, note };
  if ("has_more" in result) out.has_more = true;
  return out;
}

// ── tool calls ─────────────────────────────────────────────────────────

type CallResult = {
  content: { type: "text"; text: string }[];
  isError: boolean;
  structuredContent?: Row;
};

const toolError = (text: string): CallResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

/**
 * One tools/call. Argument errors come back before any audit (the Python SDK rejected them
 * before the tool ran); refused and failed calls are audited with their status and read
 * back as "Error executing tool <name>: <status>: <detail>", which agents parse.
 */
export async function callTool(
  d: ToolDeps,
  context: () => Promise<AgentContext>,
  name: string,
  args: Record<string, unknown>,
): Promise<CallResult> {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) {
    const known = [...TOOL_BY_NAME.keys()].sort();
    // The only place an agent reaching for a missing tool shows up: the roadmap signal.
    try {
      const ctx = await context();
      await ctx.record(
        "unknown_tool",
        { requested: name, arguments: Object.keys(args).sort() },
        null,
        "denied",
      );
    } catch {
      d.logger.warn({ tool: name }, "unknown tool requested, audit skipped");
    }
    return toolError(
      `Unknown tool: ${name}. Available: ${known.join(", ")}. ` +
        "Call dembrane_list_tools for what each one does, or " +
        "dembrane_request_tool if none of them fits what you needed.",
    );
  }
  let a: Row;
  try {
    a = validateArgs(name, tool.params, args);
  } catch (err) {
    if (err instanceof ArgumentError)
      return toolError(`Error executing tool ${name}: ${err.message}`);
    throw err;
  }
  let ctx: AgentContext;
  try {
    ctx = await context();
  } catch {
    return toolError(`Error executing tool ${name}`);
  }
  const params = tool.audit(a);
  let result: Row;
  try {
    result = await tool.run(d, ctx, a);
  } catch (err) {
    await ctx.record(name, params, null, auditStatus(err));
    if (err instanceof PlatformError)
      return toolError(`Error executing tool ${name}: ${err.status}: ${detailOf(err)}`);
    d.logger.error({ err, tool: name }, "agent tool crashed");
    return toolError(`Error executing tool ${name}`);
  }
  await ctx.record(name, params, null, "ok");
  const fitted = fit(result);
  return {
    content: [{ type: "text", text: pyJson(fitted) }],
    isError: false,
    structuredContent: fitted,
  };
}

/** The detail as FastAPI's HTTPException printed it in the f-string. */
function detailOf(err: PlatformError): string {
  return err.details === undefined ? err.message : pyRepr(err.details);
}

/** A JSON-RPC error thrown from a handler: the SDK sends code, message and data as given. */
function rpcError(code: number, message: string, data?: unknown): Error {
  return Object.assign(new Error(message), { code, ...(data !== undefined && { data }) });
}

function buildServer(d: ToolDeps, context: () => Promise<AgentContext>): Server {
  const server = new Server(
    { name: "dembrane", version: "" },
    {
      capabilities: {
        experimental: {},
        prompts: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
        tools: { listChanged: false },
      },
      instructions: INSTRUCTIONS,
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_LIST }));
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    callTool(d, context, req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>),
  );
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    throw rpcError(0, `Unknown prompt: ${req.params.name}`);
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    throw rpcError(-32602, `Unknown resource: ${req.params.uri}`, { uri: req.params.uri });
  });
  return server;
}

// ── HTTP ───────────────────────────────────────────────────────────────

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const rpcFailure = (status: number, code: number, message: string) =>
  json(status, { jsonrpc: "2.0", id: null, error: { code, message } });

/** The Accept check of the Python transport: wildcards count, JSON is enough in JSON mode. */
function accepts(header: string | null) {
  const types = (header ?? "")
    .split(",")
    .map((t) => (t.trim().split(";")[0] ?? "").trim().toLowerCase());
  const any = types.includes("*/*");
  return {
    json: any || types.includes("application/json") || types.includes("application/*"),
    sse: any || types.includes("text/event-stream") || types.includes("text/*"),
  };
}

const MESSAGE_KINDS = [
  ["JSONRPCRequest", ["jsonrpc", "id", "method"]],
  ["JSONRPCNotification", ["jsonrpc", "method"]],
  ["JSONRPCResponse", ["jsonrpc", "id", "result"]],
  ["JSONRPCError", ["jsonrpc", "id", "error"]],
] as const;

/**
 * pydantic's union error for a body that is not one JSON-RPC message: a non-object, or an
 * object missing the members every message kind requires. Null when the body is a message
 * (or fails in a way the SDK reports itself).
 */
function messageProblem(raw: unknown): string | null {
  const head = "for union[JSONRPCRequest,JSONRPCNotification,JSONRPCResponse,JSONRPCError]";
  const issue = (loc: string, msg: string, type: string) =>
    `${loc}\n  ${msg} [type=${type}, input_value=${short(raw)}, input_type=${pyTypeOf(raw)}]\n    For further information visit https://errors.pydantic.dev/2.12/v/${type}`;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    const lines = MESSAGE_KINDS.map(([kind]) =>
      issue(kind, `Input should be a valid dictionary or instance of ${kind}`, "model_type"),
    );
    return `Validation error: ${lines.length} validation errors ${head}\n${lines.join("\n")}`;
  }
  const r = raw as Row;
  const missing: string[] = [];
  let anyMatches = false;
  for (const [kind, fields] of MESSAGE_KINDS) {
    const absent = fields.filter((f) => !(f in r));
    if (!absent.length) anyMatches = true;
    for (const f of absent) missing.push(issue(`${kind}.${f}`, "Field required", "missing"));
  }
  if (anyMatches) return null;
  return `Validation error: ${missing.length} validation error${missing.length === 1 ? "" : "s"} ${head}\n${missing.join("\n")}`;
}

function short(v: unknown): string {
  const r = pyRepr(v);
  return r.length > 50 ? `${r.slice(0, 25)}...${r.slice(-24)}` : r;
}

function pyTypeOf(v: unknown): string {
  if (v === null) return "NoneType";
  if (Array.isArray(v)) return "list";
  if (typeof v === "string") return "str";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  return "dict";
}

/**
 * POST /api/mcp for an authenticated caller. Malformed requests get the Python transport's
 * answers; well-formed ones go to the SDK, one server and transport per request.
 */
export async function handleMcpPost(
  req: Request,
  d: ToolDeps,
  context: () => Promise<AgentContext>,
): Promise<Response> {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json"))
    return new Response("Invalid Content-Type header", { status: 400 });
  if (!accepts(req.headers.get("accept")).json)
    return rpcFailure(406, -32600, "Not Acceptable: Client must accept application/json");
  const body = await req.text();
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return rpcFailure(400, -32700, `Parse error: ${jsonErrorText(body)}`);
  }
  const problem = messageProblem(raw);
  if (problem) return rpcFailure(400, -32602, problem);
  const msg = raw as Row;
  const isRequest = "id" in msg && "method" in msg;
  if (isRequest && typeof msg.method === "string" && !METHODS.has(msg.method))
    return json(200, {
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: "Method not found", data: msg.method },
    });
  if (isRequest && msg.method === "tools/call") {
    const p = msg.params as Row | undefined;
    if (!p || typeof p !== "object" || typeof p.name !== "string")
      return json(200, {
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32602, message: "Invalid request parameters", data: "" },
      });
  }
  // The SDK wants both media types even in JSON mode, where the Python transport asked for
  // JSON only; the checks above already applied the Python rules. The version header goes
  // through as sent: the SDK serves the same handshake versions, and refuses the 2026
  // per-request envelope the Python SDK had started to accept, which no client sends yet.
  const headers = new Headers(req.headers);
  headers.set("accept", "application/json, text/event-stream");
  headers.set("content-type", "application/json");
  const server = buildServer(d, context);
  // No session id generator: stateless, like the Python server, so any instance answers.
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  try {
    const res = await transport.handleRequest(
      new Request(req.url, { method: "POST", headers, body }),
      { parsedBody: raw },
    );
    // Notifications answer 202 with an empty body, as the Python transport did.
    return res.status === 202
      ? new Response(null, { status: 202, headers: { "content-type": "application/json" } })
      : res;
  } finally {
    await server.close();
  }
}

/** Python's str(datetime) for an aware UTC instant, as sse-starlette stamped its pings. */
function pingStamp(d: Date): string {
  return `${d
    .toISOString()
    .replace("T", " ")
    .replace(/\.(\d{3})Z$/, ".$1000")}+00:00`;
}

const PING_MS = 15_000;

/**
 * GET /api/mcp: the server-to-client event stream. Stateless, so nothing is ever sent on
 * it but the comment pings every 15 seconds that keep proxies from closing it.
 */
export function handleMcpGet(req: Request): Response {
  if (!accepts(req.headers.get("accept")).sse)
    return rpcFailure(406, -32600, "Not Acceptable: Client must accept text/event-stream");
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream({
    start(controller) {
      timer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping - ${pingStamp(new Date())}\r\n\r\n`));
        } catch {
          clearInterval(timer);
        }
      }, PING_MS);
      req.signal.addEventListener("abort", () => clearInterval(timer));
    },
    cancel() {
      clearInterval(timer);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream",
      "x-accel-buffering": "no",
    },
  });
}

/** DELETE /api/mcp: there are no sessions to end. */
export function handleMcpDelete(): Response {
  return rpcFailure(405, -32600, "Method Not Allowed: Session termination not supported");
}

export { json };
