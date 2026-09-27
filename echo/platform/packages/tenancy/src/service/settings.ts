import { POLICIES, type Policy, ROLE_POLICIES, ROLE_RANK, type WorkspaceRole } from "@echo/access";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "@echo/core";
import type { schema } from "@echo/db";
import { isoTimestamp } from "@echo/legacy-shape";
import {
  blocksNewWorkspace,
  commercial,
  createWorkspaceAccount,
  hasActiveBilling,
  isExternalClient,
  orgAccountForNewWorkspace,
  reconcileSeats,
  updateAccount,
} from "../billing";
import type { WorkspaceContext } from "../context";
import { iso } from "../db";
import { clock, type TenancyDeps } from "../deps";
import { PaymentRequiredError } from "../errors";
import { checkLogoFile, deleteLogo, isOwnedFile, saveLogo } from "../logos";
import { emit } from "../notify";
import { pendingWorkspaceInvites } from "../storage/invites";
import { appUser, appUsersByIds, avatars } from "../storage/people";
import { cancelPendingTasks, pendingSupportRequests, scheduleTask } from "../storage/support";
import {
  activeOrgMembership,
  billingAccountById,
  countManagers,
  membershipById,
  orgById,
  updateMembership,
  updateWorkspace,
  workspaceById,
  workspaceMembers,
} from "../storage/tenancy";
import {
  REMINDER_INTERVAL_MS,
  recordSupportEvent,
  revokeAllSupport,
  supersedePendingRequests,
} from "../support";
import { oneLine, workspaceService } from "./workspaces";

type WorkspacePatch = Partial<typeof schema.workspace.$inferInsert>;

/**
 * The order the settings page lists policies in (the old admin preset). The owner gets the
 * full list sorted, as before. workspace:api_access is gone (spec L-26, CTO Q10).
 */
const DISPLAY_ORDER: readonly Policy[] = [
  "project:read",
  "project:create",
  "project:update",
  "project:delete",
  "project:share",
  "project:set_private",
  "project:move",
  "conversation:read",
  "conversation:delete",
  "chat:use",
  "report:view",
  "report:generate",
  "report:publish",
  "report:delete",
  "member:invite",
  "member:manage",
  "settings:manage",
  "workspace:view_usage",
  "workspace:view_invoices",
  "workspace:update_payment",
  "workspace:export",
  "workspace:set_private",
  "workspace:whitelabel",
  "workspace:webhooks",
  "upgrade:request",
];

export function myPolicies(ctx: WorkspaceContext): string[] {
  if (ctx.role === "owner") return [...POLICIES].sort();
  // The role's preset, then extra policies granted on the membership, as the old API listed them.
  const preset = DISPLAY_ORDER.filter((p) => ROLE_POLICIES[ctx.role].has(p));
  return [...preset, ...ctx.access.extra];
}

const LEGAL_BASIS = ["client-managed", "consent", "dembrane-events"] as const;

/** Merges a legal-basis edit with what is stored; consent needs a privacy policy link. */
export function legalBasisWrite(
  sent: ReadonlySet<string>,
  body: { legal_basis: string | null; privacy_policy_url: string | null },
  stored: { legal_basis: string | null; privacy_policy_url: string | null },
) {
  const basisSent = sent.has("legal_basis");
  const urlSent = sent.has("privacy_policy_url");
  if (!basisSent && !urlSent) return null;
  const basis = basisSent ? body.legal_basis : stored.legal_basis;
  let url = urlSent ? body.privacy_policy_url : stored.privacy_policy_url;
  if (basis === "consent") {
    if (!url?.trim())
      throw new BadRequestError("A privacy policy link is required for consent-based processing");
    const cleaned = url.trim();
    if (cleaned.length > 255)
      throw new BadRequestError("Privacy policy URL must be 255 characters or fewer");
    if (!/^https?:\/\//i.test(cleaned))
      throw new BadRequestError("Privacy policy URL must start with http:// or https://");
    url = cleaned;
  } else {
    url = null;
  }
  return {
    payload: { legal_basis: basis, privacy_policy_url: url },
    // Only a new dembrane-events choice is checked; an unchanged echo never 403s.
    needsDembraneEmail: basis === "dembrane-events" && stored.legal_basis !== "dembrane-events",
  };
}

export { LEGAL_BASIS };

/** http(s) only, so a logo can never become a script or file URL downstream. */
export function validLogoUrl(value: string): string {
  const cleaned = value.trim();
  if (!cleaned) return "";
  if (cleaned.length > 2048) throw new BadRequestError("Logo URL is too long");
  if (!/^https?:\/\//i.test(cleaned))
    throw new BadRequestError("Logo URL must start with http:// or https://");
  return cleaned;
}

export interface UpdateSettingsInput {
  name: string | null;
  description: string | null;
  context: string | null;
  logo_url: string | null;
  visibility: "open_to_organisation" | "invite_only" | "private" | null;
  allow_support_access: boolean | null;
  legal_basis: string | null;
  privacy_policy_url: string | null;
}

export interface DataOwnershipInput {
  usage_context: "internal" | "external" | null;
  data_owner_org_name: string | null;
  data_owner_email: string | null;
  partner_agreement_accepted: boolean | null;
}

const PAID_RESCOPE =
  "This workspace has active or paid billing attached, so its internal/external classification can't be changed automatically. Reach out to your account manager to move the billing first.";

const OUTSIDERS = new Set(["external", "observer"]);

export function settingsService(deps: TenancyDeps) {
  const { db } = deps;
  const workspaces = workspaceService(deps);

  async function loadMembership(ctx: WorkspaceContext, membershipId: string) {
    const m = await membershipById(db, membershipId);
    if (!m || m.workspace_id !== ctx.workspaceId)
      throw new NotFoundError("Membership not found in this workspace");
    if (m.deleted_at) throw new NotFoundError("Membership already removed");
    return m;
  }

  /** Only an owner touches an owner (spec H-12). */
  function guardOwnerTarget(ctx: WorkspaceContext, targetRole: string) {
    if (targetRole === "owner" && ctx.role !== "owner")
      throw new ForbiddenError("Only an owner can change or remove an owner");
  }

  return {
    /** Workspace detail and members; emails and pending invites only for member managers. */
    async get(ctx: WorkspaceContext) {
      const ws = await workspaceById(db, ctx.workspaceId);
      if (!ws) throw new NotFoundError("Workspace not found");
      const canManage = ctx.allows("member:manage");
      const org = await orgById(db, ws.org_id);
      const rows = await workspaceMembers(db, ws.id);
      const users = new Map(
        (
          await appUsersByIds(
            db,
            rows.map((r) => r.user_id),
          )
        ).map((u) => [u.id, u]),
      );
      const av = await avatars(
        db,
        [...users.values()].map((u) => u.directus_user_id),
      );
      const members = rows.flatMap((m) => {
        const u = users.get(m.user_id);
        if (!u) return [];
        const showEmail = canManage || m.user_id === ctx.who.appUserId;
        return [
          {
            id: m.id,
            user_id: m.user_id,
            display_name: u.display_name ?? "",
            email: showEmail ? (u.email ?? "") : "",
            avatar: av.get(u.directus_user_id ?? "") ?? null,
            role: m.role,
            source: m.source,
          },
        ];
      });
      const now = clock(deps);
      const invites = canManage
        ? await pendingWorkspaceInvites(db, [ws.id], iso(now), { limit: 50 })
        : [];
      const inviters = new Map(
        (
          await appUsersByIds(
            db,
            invites.map((i) => i.invited_by ?? ""),
          )
        ).map((u) => [u.id, u.display_name ?? ""]),
      );
      const account = await billingAccountById(db, ws.billing_account_id);
      const billing = commercial(account);
      const settings = (ws.settings ?? {}) as { inherit_organisation_members?: unknown };
      return {
        id: ws.id,
        name: ws.name ?? "",
        tier: billing?.tier || "",
        org_id: ws.org_id,
        org_name: org?.name ?? "",
        is_default: ws.is_default,
        legal_basis: ws.legal_basis,
        privacy_policy_url: ws.privacy_policy_url,
        description: ws.description,
        context: ws.context,
        members,
        pending_invites: invites.map((i) => ({
          id: i.id,
          email: i.email,
          role: i.role,
          created_at: isoTimestamp(i.created_at),
          invited_by_name: inviters.get(i.invited_by ?? "") || null,
          expires_at: isoTimestamp(i.expires_at),
        })),
        my_role: ctx.role,
        my_policies: myPolicies(ctx),
        visibility: ws.visibility || "open_to_organisation",
        inherit_organisation_members: settings.inherit_organisation_members === true,
        allow_support_access: ws.allow_support_access,
        logo_url: ws.logo_url,
        type_discount: billing?.type_discount ?? null,
        percent_discount: billing?.percent_discount ?? null,
        billing_period: billing?.billing_period ?? null,
        billing_account_id: ws.billing_account_id,
        billing_status: billing?.status ?? null,
        billing_org_managed: billing?.org_scoped ?? false,
        usage_context: ws.usage_context,
        is_external_client: isExternalClient(ws),
        data_owner_org_name: ws.data_owner_org_name,
        data_owner_email: ws.data_owner_email,
      };
    },

    /** Name, description, context, logo, visibility, support consent and legal basis. */
    async update(ctx: WorkspaceContext, body: UpdateSettingsInput, sent: ReadonlySet<string>) {
      ctx.require("settings:manage");
      const now = clock(deps);
      const ws = await workspaceById(db, ctx.workspaceId);
      if (!ws) throw new NotFoundError("Workspace not found");
      const payload: WorkspacePatch = {};
      if (body.name !== null) payload.name = oneLine(body.name);
      if (body.description !== null) payload.description = body.description.trim();
      if (body.context !== null) payload.context = body.context.trim() || null;
      if (body.logo_url !== null) {
        const cleaned = validLogoUrl(body.logo_url);
        if (cleaned !== (ws.logo_url || "")) ctx.require("workspace:whitelabel");
        payload.logo_url = cleaned || null;
      }
      if (body.visibility !== null) {
        const current = ws.visibility || "open_to_organisation";
        if (body.visibility !== "open_to_organisation" && current === "open_to_organisation")
          ctx.require("workspace:set_private");
        payload.visibility = body.visibility;
      }
      let supportChanged = false;
      if (body.allow_support_access !== null) {
        // Consent is the customer's: a staff support session cannot grant itself more (H-13).
        ctx.requireCustomer();
        supportChanged = body.allow_support_access !== ws.allow_support_access;
        payload.allow_support_access = body.allow_support_access;
      }
      const legal = legalBasisWrite(sent, body, ws);
      if (legal) {
        if (legal.needsDembraneEmail) {
          const me = await appUser(db, ctx.who.appUserId);
          if (!(me?.email ?? "").toLowerCase().endsWith("@dembrane.com"))
            throw new ForbiddenError("dembrane-events is only available for dembrane accounts");
        }
        Object.assign(payload, legal.payload);
      }
      if (!Object.keys(payload).length) throw new BadRequestError("Nothing to update");

      await db.transaction(async (tx) => {
        await updateWorkspace(tx, ws.id, { ...payload, updated_at: iso(now) });
        if (!supportChanged) return;
        const actor = ctx.who.appUserId;
        const support = { jobs: deps.jobs, dashboardUrl: deps.dashboardUrl };
        if (body.allow_support_access) {
          await scheduleTask(
            tx,
            iso(now),
            "support_toggle_reminder",
            iso(new Date(now.getTime() + REMINDER_INTERVAL_MS)),
            { workspace_id: ws.id },
          );
          await recordSupportEvent(support, tx, now, {
            workspaceId: ws.id,
            event: "toggle_enabled",
            actor,
          });
          await supersedePendingRequests(
            support,
            tx,
            now,
            ws.id,
            actor,
            await pendingSupportRequests(tx, ws.id, { byId: true }),
          );
        } else {
          await cancelPendingTasks(tx, iso(now), "support_toggle_reminder", {
            workspace_id: ws.id,
          });
          await recordSupportEvent(support, tx, now, {
            workspaceId: ws.id,
            event: "toggle_disabled",
            actor,
          });
          // Turning consent off ends live staff sessions now, not up to 24 hours later (H-13).
          await revokeAllSupport(support, tx, now, ws.id);
        }
      });
      return { status: "success" };
    },

    /**
     * Internal or external classification and the data owner. A flip re-scopes the billing
     * account so the label and the billing context never disagree; paid billing blocks it.
     * Only an admin of the workspace's org may do this: it moves billing (spec M-15).
     */
    async dataOwnership(ctx: WorkspaceContext, body: DataOwnershipInput) {
      ctx.require("settings:manage");
      const now = clock(deps);
      const ws = await workspaceById(db, ctx.workspaceId);
      if (!ws) throw new NotFoundError("Workspace not found");
      const orgRow = await activeOrgMembership(db, ws.org_id, ctx.who.appUserId);
      if (!orgRow || !["admin", "owner"].includes(orgRow.role))
        throw new ForbiddenError("Only an organisation admin can change data ownership");
      const currentlyExternal = isExternalClient(ws);
      const targetExternal =
        body.usage_context !== null ? body.usage_context === "external" : currentlyExternal;
      const email =
        ((body.data_owner_email !== null ? body.data_owner_email : ws.data_owner_email) ?? "")
          .trim()
          .toLowerCase() || null;
      const orgName =
        (
          (body.data_owner_org_name !== null ? body.data_owner_org_name : ws.data_owner_org_name) ??
          ""
        ).trim() || null;

      if (targetExternal) {
        if (!email || !orgName)
          throw new BadRequestError(
            "An external workspace needs an owning organisation name and a data owner email.",
          );
        if (!currentlyExternal && !body.partner_agreement_accepted)
          throw new BadRequestError(
            "You must accept the partner agreement to mark this workspace as external.",
          );
        if (await workspaces.isOrgMemberByEmail(ws.org_id, email))
          throw new BadRequestError(
            "That data owner is already a member of your organisation. External-client workspaces need a data owner outside your organisation.",
          );
      }

      await db.transaction(async (tx) => {
        const payload: WorkspacePatch = {};
        const oldId = ws.billing_account_id;
        if (targetExternal) {
          if (!currentlyExternal) {
            if (hasActiveBilling(await billingAccountById(tx, oldId)))
              throw new ConflictError(PAID_RESCOPE);
            const newAccount = await createWorkspaceAccount(tx, now, {
              createdBy: ctx.who.appUserId,
              label: `${ws.name || "Workspace"} billing`,
            });
            payload.billing_account_id = newAccount;
            await updateAccount(tx, now, newAccount, { workspace_id: ws.id });
            for (const id of new Set([oldId, newAccount])) await reconcileSeats(deps.jobs, tx, id);
          }
          payload.usage_context = "external";
          payload.data_owner_org_name = orgName;
          payload.data_owner_email = email;
          if (!ws.partner_agreement_accepted_at) payload.partner_agreement_accepted_at = iso(now);
        } else {
          if (currentlyExternal) {
            if (hasActiveBilling(await billingAccountById(tx, oldId)))
              throw new ConflictError(PAID_RESCOPE);
            const pooled = await orgAccountForNewWorkspace(tx, now, ws.org_id, ctx.who.appUserId);
            const blocked = blocksNewWorkspace(await billingAccountById(tx, pooled));
            if (blocked) throw new PaymentRequiredError(blocked);
            payload.billing_account_id = pooled;
            // The workspace-scoped account is orphaned: retire it.
            if (oldId && oldId !== pooled)
              await updateAccount(tx, now, oldId, { deleted_at: iso(now), workspace_id: null });
            for (const id of new Set([oldId, pooled])) await reconcileSeats(deps.jobs, tx, id);
          }
          payload.usage_context = "internal";
          payload.data_owner_org_name = null;
          payload.data_owner_email = null;
          payload.partner_agreement_accepted_at = null;
        }
        await updateWorkspace(tx, ws.id, { ...payload, updated_at: iso(now) });
        if (targetExternal && email && email !== (ws.data_owner_email ?? "").trim().toLowerCase())
          await workspaces.inviteDataOwner(tx, now, {
            workspaceId: ws.id,
            workspaceName: ws.name ?? "",
            orgName: orgName ?? "",
            email,
            invitedBy: ctx.who.appUserId,
          });
      });
      return { status: "success" };
    },

    /** Uploads a whitelabel logo (changemaker and up) and removes the previous file if it was ours. */
    async uploadLogo(ctx: WorkspaceContext, file: File) {
      ctx.require("settings:manage");
      ctx.require("workspace:whitelabel");
      checkLogoFile(file);
      const now = clock(deps);
      const ws = await workspaceById(db, ctx.workspaceId);
      const prev = ws?.logo_url ?? "";
      const fileId = await db.transaction(async (tx) => {
        const id = await saveLogo(deps.logos, tx, now, file);
        await updateWorkspace(tx, ctx.workspaceId, { logo_url: id, updated_at: iso(now) });
        return id;
      });
      if (isOwnedFile(prev)) await deleteLogo(deps.logos, db, prev);
      return { file_id: fileId };
    },

    async removeLogo(ctx: WorkspaceContext) {
      ctx.require("settings:manage");
      const now = clock(deps);
      const ws = await workspaceById(db, ctx.workspaceId);
      const prev = ws?.logo_url ?? "";
      if (!prev) return { status: "ok" };
      await updateWorkspace(db, ctx.workspaceId, { logo_url: null, updated_at: iso(now) });
      if (isOwnedFile(prev)) await deleteLogo(deps.logos, db, prev);
      return { status: "ok" };
    },

    /**
     * Soft-deletes a membership: self-leave needs no policy, removing someone else needs
     * member:manage. The last owner and the last admin stay. If the person still reaches the
     * workspace through their org role, a tombstone keeps derivation from re-granting it.
     */
    async removeMember(ctx: WorkspaceContext, membershipId: string) {
      const m = await loadMembership(ctx, membershipId);
      const selfLeave = m.user_id === ctx.who.appUserId;
      if (!selfLeave) {
        ctx.require("member:manage");
        ctx.requireCustomer();
        guardOwnerTarget(ctx, m.role);
      }
      // Support rows are not managers: they neither count toward nor are held by the last-manager rule.
      const realManager = m.source !== "staff_support";
      if (
        realManager &&
        m.role === "owner" &&
        (await countManagers(db, ctx.workspaceId, ["owner"])) <= 1
      )
        throw new BadRequestError("Cannot remove the last owner. Transfer ownership first.");
      if (
        realManager &&
        m.role === "admin" &&
        (await countManagers(db, ctx.workspaceId, ["admin", "owner"])) <= 1
      )
        throw new BadRequestError(
          selfLeave
            ? "You're the only admin. Promote someone else before leaving."
            : "Can't remove the last admin. Promote someone else first.",
        );
      const now = clock(deps);
      const ws = await workspaceById(db, ctx.workspaceId);
      await db.transaction(async (tx) => {
        await updateMembership(tx, m.id, { deleted_at: iso(now), updated_at: iso(now) });
        await reconcileSeats(deps.jobs, tx, ws?.billing_account_id);
        if (m.user_id !== ctx.who.appUserId)
          await emit(tx, now, m.user_id, {
            actor: ctx.who.appUserId,
            event: "WORKSPACE_REMOVED",
            title: `You were removed from ${ws?.name ?? "a workspace"}`,
            message: "Reach out to the workspace admin if this was unexpected.",
            action: "NONE",
            workspaceId: ctx.workspaceId,
          });
        if (ws && (await activeOrgMembership(tx, ws.org_id, m.user_id))) {
          const settings = { ...((ws.settings ?? {}) as Record<string, unknown>) };
          const tombstones = Array.isArray(settings.sticky_removed)
            ? [...(settings.sticky_removed as unknown[])]
            : [];
          const already = tombstones.some(
            (t) => t && typeof t === "object" && (t as { user_id?: unknown }).user_id === m.user_id,
          );
          if (!already) {
            tombstones.push({
              user_id: m.user_id,
              removed_at: iso(now),
              removed_by: ctx.who.appUserId,
            });
            await updateWorkspace(tx, ws.id, {
              settings: { ...settings, sticky_removed: tombstones },
              updated_at: iso(now),
            });
          }
        }
      });
      return { status: "success" };
    },

    /** Changes a member's role, never above the caller's own and never across the insider line. */
    async changeRole(ctx: WorkspaceContext, membershipId: string, role: string) {
      ctx.require("member:manage");
      if (!["member", "billing", "admin", "owner"].includes(role))
        throw new BadRequestError("Invalid role");
      if (ROLE_RANK[role as WorkspaceRole] > ROLE_RANK[ctx.role])
        throw new ForbiddenError("Cannot grant a role higher than your own");
      const m = await loadMembership(ctx, membershipId);
      ctx.requireCustomer();
      guardOwnerTarget(ctx, m.role);
      if (OUTSIDERS.has(m.role) !== OUTSIDERS.has(role))
        throw new BadRequestError(
          "Cannot change an outside collaborator (external or observer) into a member, or vice versa, from this dropdown. Re-invite the user to the workspace with the new role instead.",
        );
      if (
        m.role === "owner" &&
        role !== "owner" &&
        (await countManagers(db, ctx.workspaceId, ["owner"])) <= 1
      )
        throw new BadRequestError("Cannot demote the last owner. Promote someone else first.");
      if (
        m.role === "admin" &&
        !["admin", "owner"].includes(role) &&
        (await countManagers(db, ctx.workspaceId, ["admin", "owner"])) <= 1
      )
        throw new BadRequestError("Cannot demote the last admin. Promote someone else first.");
      const now = clock(deps);
      const ws = await workspaceById(db, ctx.workspaceId);
      await db.transaction(async (tx) => {
        await updateMembership(tx, m.id, { role, updated_at: iso(now) });
        await reconcileSeats(deps.jobs, tx, ws?.billing_account_id);
        if (m.user_id !== ctx.who.appUserId)
          await emit(tx, now, m.user_id, {
            actor: ctx.who.appUserId,
            event: "WORKSPACE_ROLE_CHANGED",
            title: `Your role changed in ${ws?.name ?? "a workspace"}`,
            message: `You're now a **${role}** here.`,
            action: "NAVIGATE_WS",
            workspaceId: ctx.workspaceId,
          });
      });
      return { status: "success" };
    },
  };
}
