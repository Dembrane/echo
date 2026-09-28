import { type Env, requireUser } from "@echo/http";
import { p } from "@echo/legacy-shape";
import { Hono } from "hono";
import type { ConversationsDeps } from "../deps";
import * as svc from "./service";

const { model, optional, required, nullable, str, int, bool, literal, list } = p;

const LIST_SORTS = [
  "-created_at",
  "created_at",
  "-participant_name",
  "participant_name",
  "-duration",
  "duration",
  "-updated_at",
  "updated_at",
] as const;

const filterQuery = {
  project_id: required(str()),
  tag_ids: optional(nullable(str()), null),
  verified_only: optional(bool(), false),
  search_text: optional(nullable(str()), null),
};

/**
 * The BFF conversation routes (/api/v2/bff/conversations, conversation-chunks and
 * conversation-project-tags). The live, live-count and monitor routes live with the
 * monitor; /count and /remaining-count are registered before /:conversation_id so the
 * literal paths win, as FastAPI's route order had it.
 */
export function bffConversationRoutes(d: ConversationsDeps) {
  const app = new Hono<Env>();
  const base = "/api/v2/bff/conversations";

  app.get(base, async (c) => {
    const who = requireUser(c);
    const { query } = await p.validate(c.req, {
      query: {
        ...filterQuery,
        include_chunks: optional(bool(), false),
        include_tags: optional(bool(), false),
        fields: optional(nullable(str()), null),
        sources: optional(nullable(str()), null),
        limit: optional(int({ ge: 1, le: 1000 }), 1000),
        offset: optional(int({ ge: 0 }), 0),
        sort: optional(literal(...LIST_SORTS), "-created_at"),
        transcript_required: optional(bool(), false),
      },
    });
    return c.json(await svc.listConversations(d, who, query));
  });

  app.get(`${base}/count`, async (c) => {
    const who = requireUser(c);
    const { query } = await p.validate(c.req, { query: filterQuery });
    return c.json(await svc.countConversations(d, who, query));
  });

  app.get(`${base}/remaining-count`, async (c) => {
    const who = requireUser(c);
    const { query } = await p.validate(c.req, {
      query: { ...filterQuery, exclude_ids: optional(nullable(str()), null) },
    });
    return c.json(await svc.countRemaining(d, who, query));
  });

  app.get(`${base}/:conversation_id`, async (c) => {
    const who = requireUser(c);
    const { query } = await p.validate(c.req, {
      query: { include_chunks: optional(bool(), false), include_tags: optional(bool(), false) },
    });
    return c.json(await svc.getConversation(d, who, c.req.param("conversation_id"), query));
  });

  app.patch(`${base}/:conversation_id`, async (c) => {
    const who = requireUser(c);
    const s = optional(nullable(str()), null);
    const b = optional(nullable(bool()), null);
    const { body } = await p.validate(c.req, {
      body: model({
        participant_name: s,
        participant_email: s,
        participant_user_agent: s,
        title: s,
        summary: s,
        merged_transcript: s,
        is_anonymized: b,
        is_finished: b,
      }),
    });
    return c.json(await svc.updateConversation(d, who, c.req.param("conversation_id"), body.data));
  });

  app.post(`${base}/:conversation_id/move`, async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: model({ target_project_id: required(str()) }),
    });
    return c.json(
      await svc.moveConversation(
        d,
        who,
        c.req.param("conversation_id"),
        body.data.target_project_id,
      ),
    );
  });

  app.get(`${base}/:conversation_id/chunks`, async (c) => {
    const who = requireUser(c);
    const { query } = await p.validate(c.req, {
      query: {
        limit: optional(int({ ge: 1, le: 1000 }), 10),
        offset: optional(int({ ge: 0 }), 0),
        sort: optional(literal("timestamp", "-timestamp"), "timestamp"),
        fields: optional(nullable(str()), null),
      },
    });
    return c.json(await svc.listChunks(d, who, c.req.param("conversation_id"), query));
  });

  app.get(`${base}/:conversation_id/chunk-count`, async (c) => {
    const who = requireUser(c);
    const { query } = await p.validate(c.req, {
      query: { transcript_required: optional(bool(), false) },
    });
    return c.json(
      await svc.countChunks(d, who, c.req.param("conversation_id"), query.transcript_required),
    );
  });

  app.get("/api/v2/bff/conversation-project-tags", async (c) => {
    const who = requireUser(c);
    const { query } = await p.validate(c.req, {
      query: { conversation_id: required(str()) },
    });
    return c.json(await svc.listTags(d, who, query.conversation_id));
  });

  app.post("/api/v2/bff/conversation-project-tags/replace", async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: model({
        conversation_id: required(str()),
        project_tag_ids: required(list(str())),
      }),
    });
    return c.json(
      await svc.replaceTags(d, who, body.data.conversation_id, body.data.project_tag_ids),
    );
  });

  return app;
}
