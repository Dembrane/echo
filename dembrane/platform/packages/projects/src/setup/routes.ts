import type { Access } from "@dembrane/access";
import type { Db } from "@dembrane/db";
import { type Env, requireUser } from "@dembrane/http";
import { p } from "@dembrane/legacy-shape";
import type { Completer } from "@dembrane/llm";
import type { Logger } from "@dembrane/observability";
import type { RateLimiter } from "@dembrane/ratelimit";
import { Hono } from "hono";
import { projectsStorage } from "../storage";
import { fetchPageText } from "./fetch-page";
import { suggestProjectSetup } from "./service";

export interface ProjectSetupRoutesDeps {
  readonly db: Db;
  readonly access: Access;
  readonly completer: Completer;
  readonly limiter: RateLimiter;
  readonly logger: Logger;
  /** WEBHOOKS_ALLOW_PRIVATE_TARGETS: local development reads pages on private addresses. */
  readonly allowPrivateTargets: boolean;
  /** PROJECT_SETUP_WEB_SEARCH, already narrowed to providers that ground with search. */
  readonly webSearch: boolean;
  readonly fetchPage?: (url: string) => Promise<string>;
  readonly now?: () => Date;
}

const { model, optional, nullable, required, str, list, bool } = p;

export const SuggestionBody = model({
  template_key: required(str({ min: 1, max: 64 })),
  name: required(str({ max: 255 })),
  // The project context, which hosts paste agendas into: the create flow sends its first
  // 20,000 characters; the saved context itself has no limit.
  description: optional(nullable(str({ max: 20_000 })), null),
  source_text: optional(nullable(str({ max: 20_000 })), null),
  source_url: optional(nullable(str({ max: 2_000 })), null),
  language: optional(str({ max: 16 }), "en"),
  existing_key_terms: optional(nullable(list(str({ max: 200 }), { max: 200 })), null),
  // The portal editor asks for key terms only: settings there have their own screens.
  include_settings: optional(bool(), true),
});

/** POST /api/v2/workspaces/:workspace_id/project-setup/suggestions */
export function projectSetupRoutes(deps: ProjectSetupRoutesDeps) {
  const d = {
    db: deps.db,
    store: projectsStorage(deps.db),
    access: deps.access,
    completer: deps.completer,
    limiter: deps.limiter,
    logger: deps.logger,
    webSearch: deps.webSearch,
    now: deps.now ?? (() => new Date()),
    fetchPage:
      deps.fetchPage ??
      ((url: string) => fetchPageText(url, { allowPrivate: deps.allowPrivateTargets })),
  };
  return new Hono<Env>().post(
    "/api/v2/workspaces/:workspace_id/project-setup/suggestions",
    async (c) => {
      const who = requireUser(c);
      const { body } = await p.validate(c.req, { body: SuggestionBody });
      return c.json(await suggestProjectSetup(d, who, c.req.param("workspace_id"), body.data));
    },
  );
}
