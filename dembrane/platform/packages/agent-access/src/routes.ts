import type { Access, AccessStore } from "@dembrane/access";
import type { Capture } from "@dembrane/analytics";
import { UnauthenticatedError } from "@dembrane/core";
import type { Db } from "@dembrane/db";
import { type Ctx, clientIp, type Env, v } from "@dembrane/http";
import type { Logger } from "@dembrane/observability";
import type { RateLimiter } from "@dembrane/ratelimit";
import { Hono } from "hono";
import { MCP_PATH, SCOPE_READ } from "./constants";
import { type AgentContext, auditStatus, contextForGrant, type SamInboxDeps } from "./context";
import { docsBaseUrlFor, docsCorpus } from "./knowledge";
import { manageRoutes } from "./manage";
import { handleMcpDelete, handleMcpGet, handleMcpPost, json } from "./mcp";
import {
  authorizationServerMetadata,
  authorize,
  type OAuthDeps,
  type Params,
  protectedResourceMetadata,
  register,
  resourceMetadataUrl,
  revoke,
  token,
  verifyAccessToken,
} from "./oauth";
import { TOOL_BY_NAME } from "./registry";
import { ClientSecretBox } from "./secrets";
import { agentStorage, type Row } from "./storage";
import { CONVERSATION_SORTS } from "./toolkit";
import { type ToolDeps, updateProject } from "./tools";

export interface AgentAccessRoutesDeps {
  readonly db: Db;
  readonly access: Access;
  readonly accessStore: AccessStore;
  readonly logger: Logger;
  readonly limiter: RateLimiter;
  readonly capture: Capture;
  readonly publicUrl: string;
  readonly dashboardUrl: string;
  readonly buildVersion: string;
  /** Directus's SECRET: the key stored client secrets are encrypted under. */
  readonly clientSecretKey: string;
  /** sam's inbox for tool requests; null when SAM_INBOX_* is unset. */
  readonly samInbox?: SamInboxDeps | null;
  readonly now?: () => Date;
}

/** Open registration is limited per address (spec L-18): enough for any real client. */
const REGISTER_LIMIT = { name: "agent_register", capacity: 20, windowSeconds: 3600 };

const reply = (r: { status: number; body: unknown; headers?: Record<string, string> }) =>
  r.body === null
    ? new Response(null, { status: r.status, ...(r.headers && { headers: r.headers }) })
    : json(r.status, r.body, r.headers);

async function formOf(c: Ctx): Promise<Params> {
  const body = await c.req.parseBody().catch(() => ({}));
  const out: Params = {};
  for (const [k, val] of Object.entries(body)) if (typeof val === "string") out[k] = val;
  return out;
}

export function agentAccessRoutes(api: AgentAccessRoutesDeps) {
  const store = agentStorage(api.db);
  const d: ToolDeps & OAuthDeps = {
    db: api.db,
    access: api.access,
    accessStore: api.accessStore,
    store,
    logger: api.logger,
    now: api.now ?? (() => new Date()),
    publicUrl: api.publicUrl,
    dashboardUrl: api.dashboardUrl,
    buildVersion: api.buildVersion,
    samInbox: api.samInbox ?? null,
    secrets: new ClientSecretBox(api.clientSecretKey),
    docs: docsCorpus({
      docsBaseUrl: docsBaseUrlFor(api.dashboardUrl),
      logger: api.logger,
    }),
  };

  const app = new Hono<Env>();

  // ── OAuth metadata and endpoints ─────────────────────────────────────

  // Browser preflights go through the app-wide CORS policy, as they went through the
  // Python app's; the metadata routes also answer a bare OPTIONS, as the SDK's did.
  const cached = { "cache-control": "public, max-age=3600" };
  const metadata = () => json(200, authorizationServerMetadata(d), cached);
  app.on(["GET", "OPTIONS"], `/.well-known/oauth-authorization-server${MCP_PATH}`, metadata);
  app.on(["GET", "OPTIONS"], `${MCP_PATH}/.well-known/oauth-authorization-server`, metadata);
  app.on(["GET", "OPTIONS"], `/.well-known/oauth-protected-resource${MCP_PATH}`, () =>
    json(200, protectedResourceMetadata(d), cached),
  );
  app.on(["GET", "POST"], `${MCP_PATH}/authorize`, async (c) => {
    const params: Params = c.req.method === "GET" ? c.req.query() : await formOf(c);
    return reply(await authorize(d, params));
  });
  app.post(`${MCP_PATH}/token`, async (c) =>
    reply(await token(d, await formOf(c), c.req.header("authorization") ?? null)),
  );
  app.post(`${MCP_PATH}/register`, async (c) => {
    await api.limiter.check(REGISTER_LIMIT, clientIp(c));
    return reply(await register(d, await c.req.text()));
  });
  app.post(`${MCP_PATH}/revoke`, async (c) =>
    reply(await revoke(d, await formOf(c), c.req.header("authorization") ?? null)),
  );

  // ── MCP endpoint ─────────────────────────────────────────────────────

  const authError = (status: number, error: string, description: string) =>
    json(
      status,
      { error, error_description: description },
      {
        "www-authenticate": `Bearer error="${error}", error_description="${description}", resource_metadata="${resourceMetadataUrl(d)}"`,
      },
    );

  app.on(["GET", "POST", "DELETE"], MCP_PATH, async (c) => {
    const header = c.req.header("authorization") ?? "";
    const verified = header.toLowerCase().startsWith("bearer ")
      ? await verifyAccessToken(d, header.slice(7))
      : null;
    if (!verified) return authError(401, "invalid_token", "Authentication required");
    if (!verified.scopes.includes(SCOPE_READ))
      return authError(403, "insufficient_scope", `Required scope: ${SCOPE_READ}`);
    if (c.req.method === "GET") return handleMcpGet(c.req.raw);
    if (c.req.method === "DELETE") return handleMcpDelete();
    return handleMcpPost(c.req.raw, d, () => contextForGrant(d, verified.grantId));
  });

  // ── REST face: /api/v2/agent ─────────────────────────────────────────

  const agent = async (c: Ctx): Promise<AgentContext> => {
    const header = c.req.header("authorization") ?? "";
    if (!header.toLowerCase().startsWith("bearer "))
      throw new UnauthenticatedError("auth.token_required");
    const verified = await verifyAccessToken(d, header.slice(7).trim());
    if (!verified) throw new UnauthenticatedError("auth.token_invalid");
    return contextForGrant(d, verified.grantId);
  };

  /** One REST call: audited like the MCP call of the same tool, answered without the size cap. */
  const run = async (c: Ctx, ctx: AgentContext, tool: string, a: Row) => {
    const def = TOOL_BY_NAME.get(tool);
    if (!def) throw new Error(`unknown tool ${tool}`);
    const params = def.audit(a);
    let result: Row;
    try {
      result = await def.run(d, ctx, a);
    } catch (err) {
      await ctx.record(tool, params, null, auditStatus(err));
      throw err;
    }
    await ctx.record(tool, params, null, "ok");
    return c.json(result);
  };

  const R = "/api/v2/agent";
  const format = v.withDefault(v.literal(["concise", "detailed"]), "concise");

  app.get(`${R}/whoami`, async (c) => run(c, await agent(c), "dembrane_whoami", {}));
  app.get(`${R}/tools`, async (c) => run(c, await agent(c), "dembrane_list_tools", {}));
  app.get(`${R}/projects/find`, async (c) => {
    const ctx = await agent(c);
    const { query } = await v.validate(c, {
      query: {
        query: v.optional(v.str()),
        workspace_id: v.optional(v.str()),
        limit: v.withDefault(v.int({ ge: 1, le: 200 }), 50),
      },
    });
    return run(c, ctx, "dembrane_find_projects", query);
  });
  app.get(`${R}/projects/:id/webhooks`, async (c) =>
    run(c, await agent(c), "dembrane_list_project_webhooks", { project_id: c.req.param("id") }),
  );
  app.get(`${R}/projects/:id/conversations`, async (c) => {
    const ctx = await agent(c);
    const { query } = await v.validate(c, {
      query: {
        search: v.optional(v.str()),
        created_after: v.optional(v.str()),
        created_before: v.optional(v.str()),
        limit: v.withDefault(v.int({ ge: 1, le: 500 }), 100),
        offset: v.withDefault(v.int({ ge: 0 }), 0),
        sort: v.withDefault(v.literal(CONVERSATION_SORTS), "-created_at"),
        format,
      },
    });
    return run(c, ctx, "dembrane_list_conversations", { project_id: c.req.param("id"), ...query });
  });
  app.get(`${R}/projects/:id/search`, async (c) => {
    const ctx = await agent(c);
    const { query } = await v.validate(c, {
      query: {
        query: v.str({ min: 1 }),
        limit: v.withDefault(v.int({ ge: 1, le: 100 }), 20),
        offset: v.withDefault(v.int({ ge: 0 }), 0),
      },
    });
    return run(c, ctx, "dembrane_search_transcripts", { project_id: c.req.param("id"), ...query });
  });
  app.get(`${R}/projects/:id`, async (c) =>
    run(c, await agent(c), "dembrane_get_project", { project_id: c.req.param("id") }),
  );
  app.patch(`${R}/projects/:id`, async (c) => {
    const ctx = await agent(c);
    const { body, bodySet } = await v.validate(c, {
      body: {
        name: v.optional(v.str()),
        context: v.optional(v.str()),
        language: v.optional(v.str()),
        is_conversation_allowed: v.optional(v.bool()),
        default_conversation_title: v.optional(v.str()),
        default_conversation_description: v.optional(v.str()),
        default_conversation_finish_text: v.optional(v.str()),
      },
    });
    // Over REST an explicit null clears the field, as the Python route's exclude_unset did.
    const fields: Row = {};
    for (const k of Object.keys(body)) if (bodySet.has(k)) fields[k] = body[k as keyof typeof body];
    const def = TOOL_BY_NAME.get("dembrane_update_project");
    if (!def) throw new Error("update tool missing");
    const params = { project_id: c.req.param("id"), fields: Object.keys(fields).sort() };
    try {
      const result = await updateProject(d, ctx, c.req.param("id"), fields);
      await ctx.record(def.name, params, null, "ok");
      return c.json(result);
    } catch (err) {
      await ctx.record(def.name, params, null, auditStatus(err));
      throw err;
    }
  });
  app.get(`${R}/conversations/:id/grep`, async (c) => {
    const ctx = await agent(c);
    const { query } = await v.validate(c, {
      query: {
        query: v.str({ min: 1 }),
        max_matches: v.withDefault(v.int({ ge: 1, le: 50 }), 10),
      },
    });
    return run(c, ctx, "dembrane_grep_conversation", {
      conversation_id: c.req.param("id"),
      ...query,
    });
  });
  app.get(`${R}/conversations/:id/transcript`, async (c) => {
    const ctx = await agent(c);
    const { query } = await v.validate(c, {
      query: {
        offset: v.withDefault(v.int({ ge: 0 }), 0),
        limit: v.withDefault(v.int({ ge: 1, le: 200 }), 50),
        format,
      },
    });
    return run(c, ctx, "dembrane_read_transcript", {
      conversation_id: c.req.param("id"),
      ...query,
    });
  });
  app.get(`${R}/conversations/:id`, async (c) =>
    run(c, await agent(c), "dembrane_get_conversation", { conversation_id: c.req.param("id") }),
  );
  app.get(`${R}/docs/read`, async (c) => {
    const ctx = await agent(c);
    const { query } = await v.validate(c, {
      query: {
        path: v.str(),
        offset: v.withDefault(v.int({ ge: 1 }), 1),
        limit: v.withDefault(v.int({ ge: 1, le: 400 }), 400),
      },
    });
    return run(c, ctx, "dembrane_read_doc", query);
  });
  app.get(`${R}/docs/search`, async (c) => {
    const ctx = await agent(c);
    const { query } = await v.validate(c, {
      query: {
        pattern: v.optional(v.str()),
        max_results: v.withDefault(v.int({ ge: 1, le: 50 }), 50),
      },
    });
    return run(c, ctx, "dembrane_search_docs", query);
  });
  app.post(`${R}/issues`, async (c) => {
    const ctx = await agent(c);
    const { body } = await v.validate(c, {
      body: {
        message: v.str({ min: 1, max: 8000 }),
        project_id: v.optional(v.str()),
        conversation_id: v.optional(v.str()),
      },
    });
    return run(c, ctx, "dembrane_report_issue", body);
  });
  app.post(`${R}/tool-requests`, async (c) => {
    const ctx = await agent(c);
    const { body } = await v.validate(c, {
      body: {
        name: v.str({ min: 1, max: 120 }),
        description: v.str({ min: 1, max: 8000 }),
        example: v.optional(v.str({ max: 2000 })),
      },
    });
    return run(c, ctx, "dembrane_request_tool", body);
  });

  app.route("/", manageRoutes(d, api.capture));
  return app;
}
