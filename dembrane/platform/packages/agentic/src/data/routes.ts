import { type Env, requireUser } from "@dembrane/http";
import { p } from "@dembrane/legacy-shape";
import { Hono } from "hono";
import type { AgenticRoutesDeps } from "../routes";
import * as chats from "./chats";
import * as convs from "./conversations";
import type { DataDeps } from "./deps";
import * as insights from "./insights";
import { INSIGHT_KINDS } from "./insights";
import * as memory from "./memory";
import { monitor } from "./monitor";
import * as project from "./project";

const { model, optional, required, nullable, str, int, bool, literal, list } = p;

export const dataDeps = (deps: AgenticRoutesDeps): DataDeps => ({
  db: deps.db,
  access: deps.access,
  logger: deps.logger,
  now: deps.now ?? (() => new Date()),
});

const projectPath = { project_id: required(str()) };
const kind = literal(...INSIGHT_KINDS);

/**
 * The reads and writes the assistant made over HTTP, and the host-facing insight routes.
 * The in-process agent calls the same functions; these routes keep the HTTP surface for
 * anything else that used it. The old agent-token check is gone: with Better Auth every
 * signed-in caller has a session, so it never refused anyone.
 */
export function dataRoutes(deps: AgenticRoutesDeps) {
  const d = dataDeps(deps);
  const app = new Hono<Env>();
  const A = "/api/agentic";

  app.get(`${A}/projects/:project_id/settings`, async (c) => {
    const who = requireUser(c);
    return c.json(await project.projectSettings(d, who, c.req.param("project_id")));
  });

  app.post(`${A}/projects/:project_id/tags`, async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      path: projectPath,
      body: model({ add: optional(list(str()), []), remove: optional(list(str()), []) }),
    });
    return c.json(
      await project.editProjectTags(
        d,
        who,
        c.req.param("project_id"),
        body.data.add,
        body.data.remove,
      ),
    );
  });

  app.get(`${A}/projects/:project_id/conversations`, async (c) => {
    const who = requireUser(c);
    const { query } = await p.validate(c.req, {
      query: {
        limit: optional(int({ ge: 1, le: 100 }), 20),
        offset: optional(int({ ge: 0 }), 0),
        conversation_id: optional(nullable(str()), null),
        transcript_query: optional(nullable(str()), null),
      },
    });
    return c.json(
      await convs.conversations(d, who, c.req.param("project_id"), {
        limit: query.limit,
        offset: query.offset,
        conversationId: query.conversation_id,
        transcriptQuery: query.transcript_query,
      }),
    );
  });

  app.get(`${A}/projects/:project_id/focused-conversations`, async (c) => {
    const who = requireUser(c);
    const { query } = await p.validate(c.req, {
      query: {
        project_chat_id: required(str()),
        limit: optional(int({ ge: 1, le: 100 }), 50),
        offset: optional(int({ ge: 0 }), 0),
      },
    });
    return c.json(
      await convs.focusedConversations(
        d,
        who,
        c.req.param("project_id"),
        query.project_chat_id,
        query.limit,
        query.offset,
      ),
    );
  });

  app.get(`${A}/projects/:project_id/monitor`, async (c) => {
    const who = requireUser(c);
    const { query } = await p.validate(c.req, {
      query: { window_seconds: optional(int({ ge: 5, le: 600 }), 45) },
    });
    return c.json(await monitor(d, who, c.req.param("project_id"), query.window_seconds));
  });

  app.get(`${A}/projects/:project_id/chats`, async (c) => {
    const who = requireUser(c);
    const { query } = await p.validate(c.req, {
      query: {
        limit: optional(int({ ge: 1, le: 200 }), 30),
        workspace_wide: optional(bool(), false),
      },
    });
    return c.json(
      await chats.chats(d, who, c.req.param("project_id"), query.limit, query.workspace_wide),
    );
  });

  app.get(`${A}/chats/:chat_id/messages`, async (c) => {
    const who = requireUser(c);
    const { query } = await p.validate(c.req, {
      query: { limit: optional(int({ ge: 1, le: 500 }), 100) },
    });
    return c.json(await chats.chatMessages(d, who, c.req.param("chat_id"), query.limit));
  });

  app.post(`${A}/projects/:project_id/support-request`, async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: model({
        message: required(str({ min: 1 })),
        page_context: optional(nullable(str()), null),
        chat_id: optional(nullable(str()), null),
        app_user_id: optional(nullable(str()), null),
        message_id: optional(nullable(str()), null),
      }),
    });
    // app_user_id comes from the session (spec L-3); the body's is accepted and ignored.
    return c.json(await insights.supportRequest(d, who, c.req.param("project_id"), body.data), 201);
  });

  app.post(`${A}/projects/:project_id/insight`, async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: model({
        kind: required(kind),
        content: required(str({ min: 1 })),
        suggested_capability: optional(nullable(str()), null),
        chat_id: optional(nullable(str()), null),
        message_id: optional(nullable(str()), null),
      }),
    });
    return c.json(await insights.noteInsight(d, who, c.req.param("project_id"), body.data), 201);
  });

  app.patch(`${A}/insights/:insight_id`, async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: model({
        content: optional(nullable(str()), null),
        kind: optional(nullable(kind), null),
        suggested_capability: optional(nullable(str()), null),
      }),
    });
    return c.json(await insights.editInsight(d, who, c.req.param("insight_id"), body.data));
  });

  app.post(`${A}/insights/:insight_id/retract`, async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: model({ reason: required(str({ min: 1 })) }),
    });
    return c.json(
      await insights.retractInsight(d, who, c.req.param("insight_id"), body.data.reason),
    );
  });

  app.post(`${A}/insights/:insight_id/dismiss`, async (c) => {
    const who = requireUser(c);
    return c.json(await insights.dismissInsight(d, who, c.req.param("insight_id")));
  });

  app.get(`${A}/projects/:project_id/dismissed-insights`, async (c) => {
    const who = requireUser(c);
    return c.json(await insights.dismissedInsights(d, who, c.req.param("project_id")));
  });

  app.get(`${A}/projects/:project_id/insights`, async (c) => {
    const who = requireUser(c);
    const { query } = await p.validate(c.req, {
      query: { chat_id: optional(nullable(str()), null) },
    });
    return c.json(
      await insights.sentInsights(d, who, c.req.param("project_id"), query.chat_id || null),
    );
  });

  app.get(`${A}/projects/:project_id/reports`, async (c) => {
    const who = requireUser(c);
    return c.json(await project.reports(d, who, c.req.param("project_id")));
  });

  app.get(`${A}/projects/:project_id/reports/:report_id`, async (c) => {
    const who = requireUser(c);
    return c.json(
      await project.report(d, who, c.req.param("project_id"), c.req.param("report_id")),
    );
  });

  app.get(`${A}/projects/:project_id/memory`, async (c) => {
    const who = requireUser(c);
    return c.json(await memory.memory(d, who, c.req.param("project_id")));
  });

  app.get(`${A}/projects/:project_id/goal`, async (c) => {
    const who = requireUser(c);
    return c.json(await project.projectGoal(d, who, c.req.param("project_id")));
  });

  app.get(`${A}/projects/:project_id/methodologies`, async (c) => {
    const who = requireUser(c);
    return c.json(await project.methodologies(d, who, c.req.param("project_id")));
  });

  app.post(`${A}/projects/:project_id/memory`, async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: model({
        scope: required(str({ min: 1 })),
        content: required(str({ min: 1 })),
        memory_key: optional(nullable(str()), null),
      }),
    });
    return c.json(await memory.writeMemory(d, who, c.req.param("project_id"), body.data));
  });

  app.patch(`${A}/memories/:memory_id`, async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: model({ content: required(str({ min: 1 })) }),
    });
    return c.json(await memory.amendMemory(d, who, c.req.param("memory_id"), body.data.content));
  });

  app.delete(`${A}/memories/:memory_id`, async (c) => {
    const who = requireUser(c);
    return c.json(await memory.forgetMemory(d, who, c.req.param("memory_id")));
  });

  return app;
}

/**
 * /v2/bff/memory: hosts see and clear what the assistant remembers. They never author it
 * here; the assistant is the only writer.
 */
export function memoryBffRoutes(deps: AgenticRoutesDeps) {
  const d = dataDeps(deps);
  const app = new Hono<Env>();
  const M = "/api/v2/bff/memory";
  app.get(`${M}/user`, async (c) => c.json(await memory.listUserMemory(d, requireUser(c))));
  app.get(`${M}/project/:project_id`, async (c) =>
    c.json(await memory.listProjectMemory(d, requireUser(c), c.req.param("project_id"))),
  );
  app.get(`${M}/workspace/:workspace_id`, async (c) =>
    c.json(await memory.listWorkspaceMemory(d, requireUser(c), c.req.param("workspace_id"))),
  );
  app.delete(`${M}/:memory_id`, async (c) =>
    c.json(await memory.deleteMemory(d, requireUser(c), c.req.param("memory_id"))),
  );
  return app;
}
