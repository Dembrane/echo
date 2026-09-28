import { directusTime } from "@dembrane/http";
import type { InviteCtx } from "./invites/accept";
import { hashMatches, urlencode } from "./invites/hash";
import { sendEmail } from "./jobs";
import { accountStorage } from "./storage";

/** Hashes are the gate; 30 probes per 5 minutes per IP make guessing them per email expensive. */
const STATUS_LIMIT = { name: "auth_invite_status", capacity: 30, windowSeconds: 300 };
const REGISTER_LIMIT = { name: "auth_register", capacity: 10, windowSeconds: 300 };

/** Cheap shape check before any lookup. Domain labels exclude "." so the pattern cannot backtrack. */
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

const status = (s: {
  status: string;
  type?: "workspace" | "org";
  workspace_name?: string;
  org_name?: string;
  role?: string | null;
  expires_at?: string | null;
}) => ({
  status: s.status,
  type: s.type ?? null,
  workspace_name: s.workspace_name ?? null,
  org_name: s.org_name ?? null,
  role: s.role ?? null,
  expires_at: s.expires_at ?? null,
});

/**
 * Public probe of an invite link, so a cancelled or expired link does not bounce a
 * signed-out visitor into registration and a stray personal org. The HMAC is the gate;
 * the email only narrows the lookup. Revoked invites read as not_found.
 */
export async function publicInviteStatus(
  ctx: InviteCtx,
  ip: string,
  q: { email: string; h: string },
) {
  const { store, now, deps } = ctx;
  await deps.limiter.check(STATUS_LIMIT, ip);
  const email = q.email.trim().toLowerCase();
  if (!email || !q.h || !EMAIL_RE.test(email)) return status({ status: "not_found" });
  const secret = deps.settings.inviteHashSecret;
  const expired = (e: string | null) => e !== null && new Date(e).getTime() < now.getTime();

  const target = (await store.liveWorkspaceInvites(email)).find((i) =>
    hashMatches(secret, i.id, q.h),
  );
  if (!target) {
    const orgTarget = (await store.liveOrgInvites(email)).find((i) =>
      hashMatches(secret, i.id, q.h),
    );
    if (!orgTarget) return status({ status: "not_found" });
    const org = await store.org(orgTarget.org_id);
    if (!org || org.deleted_at)
      return status({ status: "org_deleted", type: "org", org_name: org?.name || "" });
    const base = { type: "org" as const, org_name: org.name || "", role: orgTarget.role };
    if (orgTarget.accepted_at) return status({ status: "accepted", ...base });
    if (expired(orgTarget.expires_at))
      return status({ status: "expired", ...base, expires_at: directusTime(orgTarget.expires_at) });
    return status({ status: "pending", ...base, expires_at: directusTime(orgTarget.expires_at) });
  }
  const ws = await store.workspace(target.workspace_id);
  if (!ws || ws.deleted_at)
    return status({
      status: "workspace_deleted",
      type: "workspace",
      workspace_name: ws?.name || "",
    });
  const base = { type: "workspace" as const, workspace_name: ws.name || "", role: target.role };
  if (target.accepted_at) return status({ status: "accepted", ...base });
  if (expired(target.expires_at))
    return status({ status: "expired", ...base, expires_at: directusTime(target.expires_at) });
  return status({ status: "pending", ...base, expires_at: directusTime(target.expires_at) });
}

/**
 * Information-neutral registration: the answer is the same whether or not the email is
 * known. A new address gets an identity in Better Auth (which the auth package mirrors
 * into directus_users for foreign keys) and a verification email; a known one gets a
 * "you already have an account" email with sign-in and reset links.
 */
export async function register(
  ctx: InviteCtx,
  ip: string,
  body: {
    email: string;
    password: string;
    first_name: string;
    last_name: string | null;
    verification_url: string;
  },
): Promise<void> {
  const { deps } = ctx;
  await deps.limiter.check(REGISTER_LIMIT, ip);
  const email = body.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return;
  const account = accountStorage(deps.db);

  let known: boolean;
  try {
    known = await account.identityExists(email);
  } catch (err) {
    deps.logger?.error({ err }, "user lookup failed during registration");
    return;
  }

  if (known) {
    const qs = urlencode({ email });
    try {
      await deps.jobs.enqueue(sendEmail, {
        to: email,
        subject: "You already have a dembrane account",
        template: "registration_existing_account",
        data: {
          login_url: `${deps.settings.dashboardUrl}/login?${qs}`,
          reset_url: `${deps.settings.dashboardUrl}/request-password-reset?${qs}`,
        },
        context: "registration_existing_account",
      });
    } catch (err) {
      deps.logger?.warn({ err }, "existing-account email could not be queued");
    }
    return;
  }

  const last = body.last_name?.trim() || null;
  try {
    const res = await deps.auth.api.signUpEmail({
      body: {
        email,
        password: body.password,
        name: [body.first_name, last].filter(Boolean).join(" "),
        callbackURL: body.verification_url,
      },
    });
    await account.syncRegisteredProfile(res.user.id, {
      firstName: body.first_name,
      lastName: last,
    });
  } catch (err) {
    deps.logger?.error({ err }, "registration failed");
  }
}
