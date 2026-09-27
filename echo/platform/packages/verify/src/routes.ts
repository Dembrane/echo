import { PARTICIPANT_TOKEN_HEADER } from "@echo/conversations";
import { type Env, requireUser } from "@echo/http";
import { type Issue, p, type Type } from "@echo/legacy-shape";
import { Hono } from "hono";
import {
  createCustomTopic,
  deleteCustomTopic,
  generateArtifact,
  getArtifact,
  getTopics,
  listArtifacts,
  putTopics,
  updateArtifact,
  updateCustomTopic,
  type VerifyDeps,
  verifyContext,
} from "./service";

const { model, required, optional, nullable, str, list, datetime, nested } = p;

/** Dict[str, str]: every value a string, reported per key. */
function strDict(): Type<Record<string, string>> {
  const dict = p.dict();
  const s = str();
  return {
    parse(v, loc, issues) {
      const d = dict.parse(v, loc, issues);
      if (typeof d !== "object" || d === null) return d;
      const out: Record<string, string> = {};
      let failed = false;
      for (const [k, x] of Object.entries(d)) {
        const r = s.parse(x, [...loc, k], issues);
        if (typeof r === "string") out[k] = r;
        else failed = true;
      }
      return failed ? (s.parse(undefined, loc, []) as never) : out;
    },
  };
}

/**
 * pydantic models with aliases and populate_by_name: the camelCase alias or the field
 * name is accepted, and errors are reported at the alias.
 */
function aliased<T>(inner: Type<T>, aliases: Record<string, string>): Type<T> {
  return {
    parse(v, loc, issues: Issue[]) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const src = v as Record<string, unknown>;
        const out: Record<string, unknown> = { ...src };
        for (const [alias, name] of Object.entries(aliases))
          if (!(alias in src) && name in src) out[alias] = src[name];
        return inner.parse(out, loc, issues);
      }
      return inner.parse(v, loc, issues);
    },
  };
}

const useConversation = aliased(
  nested(model({ conversationId: required(str()), timestamp: required(datetime()) })),
  { conversationId: "conversation_id" },
);

const updateArtifactBody = aliased(
  model({
    useConversation: optional(nullable(useConversation), null),
    content: optional(nullable(str()), null),
    approvedAt: optional(nullable(str()), null),
  }),
  { useConversation: "use_conversation", approvedAt: "approved_at" },
);

/**
 * Verification topics and artifacts (v1 /api/verify). Topic reads and artifact routes
 * serve the portal without a session; topic writes need a host with project:update.
 */
export function verifyRoutes(d: VerifyDeps) {
  const ctx = verifyContext(d);
  const app = new Hono<Env>();
  const token = (c: { req: { header(n: string): string | undefined } }) =>
    c.req.header(PARTICIPANT_TOKEN_HEADER);

  app.get("/api/verify/topics/:project_id", async (c) =>
    c.json(await getTopics(ctx, c.req.param("project_id"))),
  );

  // H-1: the Python route took no session at all; the portal never calls it.
  app.put("/api/verify/topics/:project_id", async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: model({ topic_list: optional(list(str()), [] as string[]) }),
    });
    return c.json(await putTopics(ctx, who, c.req.param("project_id"), body.data.topic_list));
  });

  app.post("/api/verify/topics/:project_id/custom", async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: model({
        label: required(str({ max: 100 })),
        prompt: required(str({ max: 10000 })),
        icon: optional(nullable(str({ max: 10 })), null),
        translations: optional(strDict(), {} as Record<string, string>),
      }),
    });
    return c.json(await createCustomTopic(ctx, who, c.req.param("project_id"), body.data), 201);
  });

  app.patch("/api/verify/topics/:project_id/custom/:topic_key", async (c) => {
    const who = requireUser(c);
    const { body } = await p.validate(c.req, {
      body: model({
        label: optional(nullable(str({ max: 100 })), null),
        prompt: optional(nullable(str({ max: 10000 })), null),
        icon: optional(nullable(str({ max: 10 })), null),
        translations: optional(nullable(strDict()), null),
      }),
    });
    return c.json(
      await updateCustomTopic(
        ctx,
        who,
        c.req.param("project_id"),
        c.req.param("topic_key"),
        body.data,
      ),
    );
  });

  app.delete("/api/verify/topics/:project_id/custom/:topic_key", async (c) => {
    const who = requireUser(c);
    return c.json(
      await deleteCustomTopic(ctx, who, c.req.param("project_id"), c.req.param("topic_key")),
    );
  });

  app.get("/api/verify/artifacts/:conversation_id", async (c) =>
    c.json(await listArtifacts(ctx, c.req.param("conversation_id"), token(c))),
  );

  app.get("/api/verify/artifact/:artifact_id", async (c) =>
    c.json(await getArtifact(ctx, c.req.param("artifact_id"), token(c))),
  );

  app.post("/api/verify/generate", async (c) => {
    const { body } = await p.validate(c.req, {
      body: model({ topic_list: required(list(str())), conversation_id: required(str()) }),
    });
    return c.json(await generateArtifact(ctx, body.data, token(c)));
  });

  app.put("/api/verify/artifact/:artifact_id", async (c) => {
    const { body } = await p.validate(c.req, { body: updateArtifactBody });
    return c.json(await updateArtifact(ctx, c.req.param("artifact_id"), body.data, token(c)));
  });

  return app;
}
