import type { Config } from "@dembrane/config";
import { clientIp, type Env, requireUser, v } from "@dembrane/http";
import { audiences } from "@dembrane/notifications";
import { Hono } from "hono";
import { assetRoutes } from "./assets";
import { auditRoutes } from "./audit";
import type { AccountDeps } from "./deps";
import {
  acceptByHash,
  acceptMyInvite,
  declineMyInvite,
  type InviteCtx,
  inspectByHash,
  listMyInvites,
} from "./invites/accept";
import { resendInvite, revokeInvite } from "./invites/actions";
import { inviteToWorkspace, seatEstimate } from "./invites/send";
import { inviteStorage } from "./invites/storage";
import { completeOnboarding, submitOnboardingAnswers } from "./onboarding";
import { passwordProblems } from "./password";
import { publicInviteStatus, register } from "./registration";
import { getMe, updateMe } from "./service";
import { settingsRoutes } from "./settings";
import { accountStorage } from "./storage";

/** The API's dependencies this area reads; its settings come from config. */
export type AccountApiDeps = Omit<AccountDeps, "settings"> & { readonly config: Config };

export function accountDeps(d: AccountApiDeps): AccountDeps {
  return {
    ...d,
    settings: {
      inviteHashSecret: d.config.account.inviteHashSecret,
      dashboardUrl: d.config.http.dashboardUrl,
      onboardingFollowupInbox: d.config.account.onboardingFollowupInbox,
      directusStorageLocation: d.config.files.directusLocation,
    },
  };
}

/**
 * The signed-in user's own account (/api/v2/me, onboarding, user settings), invites in
 * both directions, public registration, the caller's audit log, and the avatar and logo
 * files Directus used to serve.
 */
export function accountRoutes(api: AccountApiDeps) {
  const deps = accountDeps(api);
  const store = accountStorage(deps.db);
  const invites = inviteStorage(deps.db);
  const aud = audiences(deps.db);
  const ctx = (): InviteCtx => ({ deps, store: invites, audiences: aud, now: new Date() });
  // An accepted invite tells customer accounts who joined which organisation.
  const joined = async <T extends { org_id?: string | null }>(out: T): Promise<T> => {
    if (out.org_id) await deps.onInviteAccepted?.(out.org_id);
    return out;
  };

  return new Hono<Env>()
    .get("/api/v2/me", async (c) => {
      const who = requireUser(c);
      return c.json(await getMe(store, who, new Date()));
    })
    .patch("/api/v2/me", async (c) => {
      const who = requireUser(c);
      const { body } = await v.validate(c, {
        body: {
          display_name: v.optional(v.str({ min: 1, max: 80 })),
          settings: v.optional(v.dict()),
        },
      });
      return c.json(await updateMe(store, who, body, new Date()));
    })
    .get("/api/v2/me/invites", async (c) => {
      const who = requireUser(c);
      return c.json(await listMyInvites(ctx(), who));
    })
    .get("/api/v2/me/invites/by-hash", async (c) => {
      const who = requireUser(c);
      const { query } = await v.validate(c, { query: { h: v.str() } });
      return c.json(await inspectByHash(ctx(), who, query.h));
    })
    .post("/api/v2/me/invites/accept-by-hash", async (c) => {
      const who = requireUser(c);
      const { body } = await v.validate(c, {
        body: { hash: v.str(), claimed_role: v.optional(v.str()) },
      });
      return c.json(await joined(await acceptByHash(ctx(), who, body)));
    })
    .post("/api/v2/me/invites/:id/accept", async (c) => {
      const who = requireUser(c);
      return c.json(await joined(await acceptMyInvite(ctx(), who, c.req.param("id"))));
    })
    .post("/api/v2/me/invites/:id/decline", async (c) => {
      const who = requireUser(c);
      return c.json(await declineMyInvite(ctx(), who, c.req.param("id")));
    })
    .post("/api/v2/onboarding/complete", async (c) => {
      const who = requireUser(c);
      const { body } = await v.validate(c, { body: { org_name: v.str({ min: 1, max: 100 }) } });
      return c.json(await completeOnboarding(ctx(), who, body));
    })
    .post("/api/v2/onboarding/answers", async (c) => {
      const who = requireUser(c);
      const { body } = await v.validate(c, {
        body: {
          version: v.withDefault(v.str({ max: 40 }), "17-jun-26"),
          data: v.withDefault(v.list(v.dict()), []),
          skipped: v.withDefault(v.bool(), false),
        },
      });
      return c.json(await submitOnboardingAnswers(ctx(), who, body));
    })
    .get("/api/v2/workspaces/:workspaceId/seat-estimate", async (c) => {
      const who = requireUser(c);
      return c.json(await seatEstimate(ctx(), who, c.req.param("workspaceId"), c));
    })
    .post("/api/v2/workspaces/:workspaceId/invite", async (c) => {
      const who = requireUser(c);
      return c.json(await inviteToWorkspace(ctx(), who, c.req.param("workspaceId"), c));
    })
    .post("/api/v2/invites/:id/resend", async (c) => {
      const who = requireUser(c);
      return c.json(await resendInvite(ctx(), who, c.req.param("id")));
    })
    .delete("/api/v2/invites/:id", async (c) => {
      const who = requireUser(c);
      return c.json(await revokeInvite(ctx(), who, c.req.param("id")));
    })
    .get("/api/v2/auth/invite-status", async (c) => {
      const { query } = await v.validate(c, { query: { email: v.str(), h: v.str() } });
      return c.json(await publicInviteStatus(ctx(), clientIp(c), query));
    })
    .post("/api/v2/auth/register", async (c) => {
      const { body } = await v.validate(c, { body: registerBody });
      await register(ctx(), clientIp(c), body);
      return c.body(null, 204);
    })
    .route("/", settingsRoutes(deps))
    .route("/", auditRoutes(deps))
    .route("/", assetRoutes(deps));
}

const registerBody = {
  email: v.str({ min: 3, max: 320 }),
  password: v.refine(v.str({ min: 8, max: 256 }), (p) => {
    const problems = passwordProblems(p);
    return problems.length ? problems.join("; ") : null;
  }),
  first_name: v.str({ min: 1, max: 150 }),
  last_name: v.optional(v.str({ max: 150 })),
  verification_url: v.str({ max: 500 }),
};
