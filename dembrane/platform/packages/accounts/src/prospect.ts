import { NotFoundError, newId, ValidationError } from "@dembrane/core";
import { schema } from "@dembrane/db";
import type { Signed } from "@dembrane/http";
import { and, eq, isNull } from "drizzle-orm";
import type { AccountsDeps, Conn } from "./deps";
import { emit } from "./events";
import type { Language } from "./offer";
import { store } from "./storage";
import { ensureBillingTask } from "./tasks";

export interface CreateAccountInput {
  readonly organisation_name: string;
  readonly contact_email: string;
  readonly contact_name: string | null;
  readonly pricing_configuration_reference: string | null;
  readonly stage: "prospect" | "customer";
  readonly language: Language;
  /** A fixed id makes a rerun find the same organisation (demo seeds). */
  readonly org_id?: string;
}

export interface CreateAccountResult {
  readonly org_id: string;
  readonly created: boolean;
  readonly contact: { readonly user_id: string; readonly created: boolean };
  readonly pricing_configuration_id: string | null;
  readonly continue_url: string;
}

/** Where "Continue in dembrane" leads: the sign-in, then the organisation's account page. */
export function continueUrl(dashboardUrl: string, orgId: string): string {
  const base = dashboardUrl.replace(/\/+$/, "");
  return `${base}/login?next=${encodeURIComponent(`/o/${orgId}/account`)}`;
}

/**
 * Creates (or finds) a customer organisation with its contact as admin. The contact signs
 * in with a code sent to their address; a password is set only when `password` is given,
 * which only the demo seed does. Idempotent: the organisation is found by its fixed id or
 * by the needs form it came from, the contact by email, and nothing is duplicated.
 */
export async function createAccount(
  d: AccountsDeps,
  actor: Signed | null,
  input: CreateAccountInput,
  /**
   * `holdSignIn`: a contact created here cannot sign in until released (a demo made in
   * echo invites its contact when it is published, never before).
   */
  opts: { password?: string; holdSignIn?: boolean } = {},
): Promise<CreateAccountResult> {
  const email = input.contact_email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    throw new ValidationError("demo.contact_email_invalid");
  const now = d.now();
  const nowIso = now.toISOString();
  const pricing = input.pricing_configuration_reference
    ? await store.pricingByReference(d.db, input.pricing_configuration_reference)
    : null;
  if (input.pricing_configuration_reference && !pricing)
    throw new NotFoundError("demo.needs_form_not_found");
  const passwordHash = opts.password
    ? await Bun.password.hash(opts.password, { algorithm: "argon2id" })
    : null;

  return d.db.transaction(async (tx) => {
    const staffAppUser = actor?.appUserId ?? null;
    // The organisation: by fixed id, else by the needs form it came from, else new.
    let orgId = input.org_id ?? null;
    let existing = orgId ? await store.org(tx, orgId) : null;
    if (!existing && pricing) {
      const [row] = await tx
        .select()
        .from(schema.org)
        .where(
          and(
            eq(schema.org.origin_pricing_configuration_id, pricing.id),
            isNull(schema.org.deleted_at),
          ),
        )
        .limit(1);
      existing = row ?? null;
    }
    if (existing?.deleted_at) throw new ValidationError("demo.organisation_deleted");
    orgId = existing?.id ?? orgId ?? newId();
    if (!existing)
      await store.insertOrg(tx, {
        id: orgId,
        name: input.organisation_name,
        account_stage: input.stage,
        origin_pricing_configuration_id: pricing?.id ?? null,
        created_by: staffAppUser,
        created_at: nowIso,
        updated_at: nowIso,
      });
    else if (!existing.account_stage)
      await store.updateOrg(tx, orgId, { account_stage: input.stage, updated_at: nowIso });
    if (pricing) await store.linkPricing(tx, pricing.id, orgId);
    if (!(await store.billing(tx, orgId)))
      await store.insertBilling(tx, {
        id: newId(),
        org_id: orgId,
        tier: "free",
        payment_mode: "none",
        billing_email: email,
        created_by: staffAppUser,
        created_at: nowIso,
        updated_at: nowIso,
      });

    const contact = await ensureUser(tx, {
      email,
      name: input.contact_name,
      passwordHash,
      nowIso,
      holdSignIn: opts.holdSignIn === true,
    });
    const membership = await store.orgMembership(tx, orgId, contact.appUserId);
    if (!membership)
      await tx.insert(schema.org_membership).values({
        id: newId(),
        org_id: orgId,
        user_id: contact.appUserId,
        role: "admin",
        created_at: nowIso,
        updated_at: nowIso,
      });
    else if (membership.deleted_at)
      await tx
        .update(schema.org_membership)
        .set({ deleted_at: null, role: "admin", updated_at: nowIso })
        .where(eq(schema.org_membership.id, membership.id));

    await ensureBillingTask(d, tx, orgId, actor?.directusUserId ?? null);
    if (!existing)
      await emit(d, tx, {
        orgId,
        actor: { kind: actor ? "staff" : "system", userId: actor?.directusUserId ?? null },
        type: "account.created",
        detail: {
          stage: input.stage,
          contact: email,
          needs_form: pricing?.reference ?? null,
        },
      });
    return {
      org_id: orgId,
      created: !existing,
      contact: { user_id: contact.userId, created: contact.created },
      pricing_configuration_id: pricing?.id ?? null,
      continue_url: continueUrl(d.settings.dashboardUrl, orgId),
    };
  });
}

/**
 * The identity rows Better Auth's own signup would make (auth_user, the directus_users row
 * foreign keys still point at, the app_user memberships use), for someone we add rather
 * than someone who signs up. Existing rows are reused; a password is only ever added.
 */
export async function ensureUser(
  tx: Conn,
  u: {
    email: string;
    name: string | null;
    passwordHash: string | null;
    nowIso: string;
    directusRoleId?: string | null;
    /** A new user starts as a Directus draft: no sign-in code until released. */
    holdSignIn?: boolean;
  },
): Promise<{ userId: string; appUserId: string; created: boolean }> {
  const found = await store.identityByEmail(tx, u.email);
  const userId = found?.id ?? newId();
  const created = !found;
  const name = u.name?.trim() || u.email.split("@")[0] || u.email;
  const at = new Date(u.nowIso);
  if (!found)
    await tx.insert(schema.auth_user).values({
      id: userId,
      name,
      email: u.email,
      // A code sign-in verifies the address; the demo's password login needs it verified.
      emailVerified: u.passwordHash !== null,
      createdAt: at,
      updatedAt: at,
    });
  else if (u.passwordHash)
    await tx
      .update(schema.auth_user)
      .set({ emailVerified: true, updatedAt: at })
      .where(eq(schema.auth_user.id, userId));
  const [first, ...rest] = name.split(" ");
  const role =
    u.directusRoleId ??
    (
      await tx
        .select({ role: schema.directus_settings.public_registration_role })
        .from(schema.directus_settings)
        .limit(1)
    )[0]?.role ??
    null;
  await tx
    .insert(schema.directus_users)
    .values({
      id: userId,
      email: u.email,
      first_name: first || null,
      last_name: rest.join(" ") || null,
      status: u.holdSignIn ? "draft" : "active",
      role,
      provider: "default",
      ...(u.passwordHash && { password: u.passwordHash }),
    })
    .onConflictDoNothing();
  if (u.directusRoleId)
    await tx
      .update(schema.directus_users)
      .set({ role: u.directusRoleId })
      .where(eq(schema.directus_users.id, userId));
  if (u.passwordHash) {
    await tx
      .update(schema.directus_users)
      .set({ password: u.passwordHash })
      .where(eq(schema.directus_users.id, userId));
    const [cred] = await tx
      .select({ id: schema.auth_account.id })
      .from(schema.auth_account)
      .where(
        and(
          eq(schema.auth_account.userId, userId),
          eq(schema.auth_account.providerId, "credential"),
        ),
      )
      .limit(1);
    if (cred)
      await tx
        .update(schema.auth_account)
        .set({ password: u.passwordHash, updatedAt: at })
        .where(eq(schema.auth_account.id, cred.id));
    else
      await tx.insert(schema.auth_account).values({
        id: newId(),
        userId,
        accountId: userId,
        providerId: "credential",
        password: u.passwordHash,
        createdAt: at,
        updatedAt: at,
      });
  }
  let app = await store.appUserByDirectusId(tx, userId);
  if (!app) {
    const appUserId = newId();
    await tx.insert(schema.app_user).values({
      id: appUserId,
      directus_user_id: userId,
      email: u.email,
      display_name: name,
      created_at: u.nowIso,
      updated_at: u.nowIso,
    });
    app = await store.appUser(tx, appUserId);
  }
  return { userId, appUserId: (app as { id: string }).id, created };
}

/** Whether a sign-in code may go to this address (Better Auth's email OTP gate). */
export function codeSignInGate(d: Pick<AccountsDeps, "db" | "now">) {
  return (email: string) => store.mayReceiveCode(d.db, email, d.now());
}

/**
 * Lets a contact created with `holdSignIn` sign in: their Directus row becomes active. A
 * user who was already active is left as they are. Returns whether anything changed.
 */
export async function releaseSignIn(c: Conn, userId: string): Promise<boolean> {
  const out = await c
    .update(schema.directus_users)
    .set({ status: "active" })
    .where(and(eq(schema.directus_users.id, userId), eq(schema.directus_users.status, "draft")))
    .returning({ id: schema.directus_users.id });
  return out.length > 0;
}
