import { DrizzleStaffAudit, requireStaff } from "@dembrane/access";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  newId,
  StatusError,
} from "@dembrane/core";
import type { Signed } from "@dembrane/http";
import { localeOfEmail, localesOfAppUsers } from "@dembrane/i18n";
import { isoTimestamp } from "@dembrane/legacy-shape";
import { seedBestPracticesJob } from "@dembrane/samples/jobs";
import {
  blocksNewWorkspace,
  commercial,
  createWorkspaceAccount,
  hasLiveMollieSubscription,
  orgAccountForNewWorkspace,
  reconcileSeats,
  updateAccount,
} from "../billing";
import { requireOnboarded, type WorkspaceContext } from "../context";
import { iso, type Tx } from "../db";
import { clock, type TenancyDeps } from "../deps";
import { tierDowngradedEmail, workspaceInviteEmail } from "../emails";
import { PaymentRequiredError } from "../errors";
import { emailJob } from "../jobs";
import { dashboardPath, inviteAcceptUrl, inviteHash } from "../links";
import { effectiveMembers, seatState, workspaceAdmins } from "../members";
import { emitToAll, orgAdmins } from "../notify";
import { pyInt, pyRound } from "../numbers";
import { countPendingInvites, insertWorkspaceInvite } from "../storage/invites";
import { appUser, appUserByEmail, appUsersByIds, avatars } from "../storage/people";
import {
  activeOrgMembership,
  billingAccountById,
  billingAccountsByIds,
  countOrgWorkspaces,
  firstManagedOrg,
  insertMembership,
  insertWorkspace,
  memberIdsByWorkspace,
  membershipsOfUser,
  orgById,
  orgMembershipsOfUser,
  orgsByIds,
  recentRemovals,
  updateWorkspace,
  type WorkspaceRowFull,
  workspaceById,
  workspaceMembers,
  workspacesByIds,
} from "../storage/tenancy";
import {
  allConversationDurations,
  clearOverCapStamps,
  conversationDurationsIn,
  countLiveProjects,
  deleteSampleProjects,
  workspaceProjects,
} from "../storage/usage";
import {
  capacityOf,
  downgradeEffects,
  nextTier,
  TIER_CAPACITIES,
  TIER_ORDER,
  tierPricing,
  usageGates,
} from "../tiers";
import {
  cardUsage,
  FREE_TIER_MAX_WORKSPACES,
  freeTierBlock,
  freeTierLimit,
  monthBounds,
  pyIso,
  withCapSignals,
} from "../usage";

export type Visibility = "open_to_organisation" | "invite_only" | "private";

export interface CreateWorkspaceInput {
  name: string;
  org_id: string | null;
  visibility: Visibility;
  data_owner_org_name: string | null;
  data_owner_email: string | null;
  partner_agreement_accepted: boolean;
}

/** Strips line breaks: names land in email subject lines. */
export function oneLine(s: string): string {
  return s.replace(/\r/g, " ").replace(/\n/g, " ").trim();
}

export function workspaceService(deps: TenancyDeps) {
  const { db } = deps;
  const staffAudit = new DrizzleStaffAudit(db);

  async function memberPreviews(workspaceId: string) {
    const ids = (await effectiveMembers(db, workspaceId)).slice(0, 4).map((m) => m.user_id);
    if (!ids.length) return [];
    // Directus returned the four app_user rows in primary key order, not preview order.
    const users = await appUsersByIds(db, ids, 4);
    const av = await avatars(
      db,
      users.map((u) => u.directus_user_id),
    );
    return users.map((u) => ({
      display_name: u.display_name ?? "",
      avatar: av.get(u.directus_user_id ?? "") ?? null,
    }));
  }

  async function isOrgMemberByEmail(orgId: string, email: string) {
    const user = await appUserByEmail(db, email);
    return user ? Boolean(await activeOrgMembership(db, orgId, user.id)) : false;
  }

  /** Invites an external client's data owner as a free observer and emails them (ISSUE-026). */
  async function inviteDataOwner(
    tx: Tx,
    now: Date,
    o: {
      workspaceId: string;
      workspaceName: string;
      orgName: string;
      email: string;
      invitedBy: string;
    },
  ) {
    const id = newId();
    await insertWorkspaceInvite(tx, {
      id,
      workspace_id: o.workspaceId,
      email: o.email,
      role: "observer",
      invited_by: o.invitedBy,
      expires_at: iso(new Date(now.getTime() + 30 * 86_400_000)),
      created_at: iso(now),
    });
    const inviterName = o.orgName || "dembrane";
    const url = inviteAcceptUrl({
      type: "workspace",
      dashboardUrl: deps.dashboardUrl,
      hash: inviteHash(id, deps.inviteSecret),
      inviterName,
      subjectName: o.workspaceName,
      role: "observer",
      email: o.email,
    });
    // The data owner's own language when they have an account, else the inviter's.
    const language =
      (await localeOfEmail(tx, o.email)) ??
      (await localesOfAppUsers(tx, [o.invitedBy])).get(o.invitedBy);
    const mail = workspaceInviteEmail(
      { inviterName, workspaceName: o.workspaceName, inviteUrl: url },
      language,
    );
    await deps.jobs.enqueue(emailJob, { to: o.email, ...mail, tags: ["workspace_invite"] }, { tx });
  }

  /** The caller administers the org (admin or owner, active row). */
  async function adminsOrg(orgId: string, appUserId: string) {
    const m = await activeOrgMembership(db, orgId, appUserId);
    return m !== null && ["admin", "owner"].includes(m.role);
  }

  /** 409 unless the workspace bills on its own account; handoff moves exactly one workspace. */
  async function requireWorkspaceScopedBilling(ws: WorkspaceRowFull) {
    const account = await billingAccountById(db, ws.billing_account_id);
    if (!account || account.org_id) throw new ConflictError("workspace.handoff_shared_plan");
    return account;
  }

  return {
    inviteDataOwner,
    isOrgMemberByEmail,

    /** Every workspace the caller holds a row on, with usage and org rollups (GET /v2/workspaces). */
    async list(who: Signed) {
      const now = clock(deps);
      if (!who.appUserId)
        return { workspaces: [], organisations: [], recent_removals: [] as unknown[] };
      const uid = who.appUserId;
      const me = await appUser(db, uid);
      const meEmail = (me?.email ?? "").trim().toLowerCase();

      // Expired support rows are listed as before (spec L-9); only deleted rows drop out.
      const memberships = await membershipsOfUser(db, uid);
      const orgMemberships = await orgMembershipsOfUser(db, uid);
      const internalOrgIds = new Set(orgMemberships.map((m) => m.org_id));
      if (!memberships.length && !orgMemberships.length)
        return { workspaces: [], organisations: [], recent_removals: [] };

      const wsRows = await workspacesByIds(
        db,
        memberships.map((m) => m.workspace_id),
        { live: true },
      );
      const accounts = await billingAccountsByIds(
        db,
        wsRows.map((w) => w.billing_account_id),
      );
      const wsMap = new Map(wsRows.map((w) => [w.id, w]));
      const orgIds = [
        ...new Set([...wsRows.map((w) => w.org_id), ...orgMemberships.map((m) => m.org_id)]),
      ];
      const orgRows = await orgsByIds(db, orgIds);
      const orgName = new Map(orgRows.map((o) => [o.id, o.name ?? ""]));
      const orgLogo = new Map(orgRows.map((o) => [o.id, o.logo_url]));

      const valid = memberships.flatMap((m) => {
        const ws = wsMap.get(m.workspace_id);
        return ws ? [{ m, ws }] : [];
      });
      const summaries = await Promise.all(
        valid.map(async ({ m, ws }) => {
          const [projectCount, memberRows, usage, previews] = await Promise.all([
            countLiveProjects(db, ws.id),
            workspaceMembers(db, ws.id),
            cardUsage(db, ws.id, now),
            memberPreviews(ws.id),
          ]);
          const account = accounts.get(ws.billing_account_id) ?? null;
          const billing = commercial(account);
          // Observers stay observers so the frontend keeps its read-only wall; any other
          // direct row outside the caller's orgs reads as external.
          const role =
            m.role === "observer"
              ? "observer"
              : m.role === "external" || (m.source === "direct" && !internalOrgIds.has(ws.org_id))
                ? "external"
                : m.role;
          const tier = billing?.tier ?? "";
          return {
            id: ws.id,
            name: ws.name ?? "",
            org_id: ws.org_id,
            org_name: orgName.get(ws.org_id) ?? "",
            role,
            is_default: ws.is_default,
            tier: billing ? billing.tier : "pioneer",
            bills_separately: account !== null && !account.org_id,
            is_data_owner:
              Boolean(meEmail) && (ws.data_owner_email ?? "").trim().toLowerCase() === meEmail,
            logo_url: ws.logo_url,
            org_logo_url: orgLogo.get(ws.org_id) ?? null,
            project_count: projectCount,
            member_count: memberRows.length,
            members_preview: previews,
            usage: withCapSignals(usage, tier),
            downgraded_at: isoTimestamp(billing?.downgraded_at),
            downgraded_from_tier: billing?.downgraded_from_tier ?? null,
            created_at: isoTimestamp(ws.created_at),
          };
        }),
      );

      const organisations = [];
      if (orgMemberships.length) {
        const orgWs = new Map(
          orgMemberships.map((om) => [om.org_id, summaries.filter((w) => w.org_id === om.org_id)]),
        );
        const allIds = [...orgWs.values()].flat().map((w) => w.id);
        // Every active row counts toward the org rollup, support rows included, as before.
        const rows = await memberIdsByWorkspace(db, allIds);
        for (const om of orgMemberships) {
          const list = orgWs.get(om.org_id) ?? [];
          const ids = new Set(list.map((w) => w.id));
          const members = new Set(
            rows.filter((r) => ids.has(r.workspace_id)).map((r) => r.user_id),
          );
          organisations.push({
            id: om.org_id,
            name: orgName.get(om.org_id) ?? "",
            role: om.role,
            logo_url: orgLogo.get(om.org_id) ?? null,
            total_projects: list.reduce((a, w) => a + w.project_count, 0),
            total_members: members.size,
            total_audio_hours: pyRound(
              list.reduce((a, w) => a + w.usage.audio_hours, 0),
              1,
            ),
            total_conversations: list.reduce((a, w) => a + w.usage.conversation_count, 0),
            workspace_count: list.length,
            total_audio_hours_this_month: pyRound(
              list.reduce((a, w) => a + w.usage.audio_hours_this_month, 0),
              1,
            ),
            total_conversations_this_month: list.reduce(
              (a, w) => a + w.usage.conversations_this_month,
              0,
            ),
          });
        }
      }

      // Only an empty selector needs to explain itself ("your access ended").
      const recent_removals: {
        workspace_id: string;
        workspace_name: string;
        org_name: string;
        ended_at: string;
      }[] = [];
      if (!summaries.length && !organisations.length) {
        const cutoff = iso(new Date(now.getTime() - 30 * 86_400_000));
        const removed = await recentRemovals(db, uid, cutoff);
        if (removed.length) {
          const removedWs = new Map(
            (
              await workspacesByIds(
                db,
                removed.map((r) => r.workspace_id),
              )
            ).map((w) => [w.id, w]),
          );
          const extra = [...removedWs.values()]
            .map((w) => w.org_id)
            .filter((id) => !orgName.has(id));
          for (const o of await orgsByIds(db, extra)) orgName.set(o.id, o.name ?? "");
          for (const r of removed) {
            const w = removedWs.get(r.workspace_id);
            if (!w) continue;
            recent_removals.push({
              workspace_id: w.id,
              workspace_name: w.name ?? "",
              org_name: orgName.get(w.org_id) ?? "",
              ended_at: isoTimestamp(r.deleted_at) ?? "",
            });
          }
        }
      }
      return { workspaces: summaries, organisations, recent_removals };
    },

    /** Self-serve workspace creation (POST /v2/workspaces). */
    async create(who: Signed, body: CreateWorkspaceInput) {
      const member = requireOnboarded(who);
      const now = clock(deps);
      let orgId = body.org_id;
      if (!orgId) {
        const first = await firstManagedOrg(db, member.appUserId);
        if (!first)
          throw new ForbiddenError("access.not_onboarded", {
            message: "No organisation found. Complete onboarding first.",
          });
        orgId = first;
      } else if (!(await adminsOrg(orgId, member.appUserId))) {
        // Staff creating inside a customer's organisation is a named, audited staff action
        // (spec H-14); everyone else gets the old refusal.
        await requireStaff(
          staffAudit,
          who,
          {
            permission: "staff:workspaces",
            action: "workspace.create",
            targetType: "org",
            targetId: orgId,
          },
          "You must be an organisation admin or owner to create a workspace here.",
        );
      }
      const name = body.name.trim();
      const dataOwnerEmail = (body.data_owner_email ?? "").trim().toLowerCase() || null;
      const dataOwnerOrgName = (body.data_owner_org_name ?? "").trim() || null;
      const separate = Boolean(dataOwnerEmail);
      if (separate) {
        if (!dataOwnerOrgName) throw new BadRequestError("workspace.data_owner_org_required");
        if (!body.partner_agreement_accepted)
          throw new BadRequestError("workspace.partner_agreement_required", {
            message:
              "You must accept the partner agreement to create an external-client workspace.",
          });
        if (dataOwnerEmail && (await isOrgMemberByEmail(orgId, dataOwnerEmail)))
          throw new BadRequestError("workspace.data_owner_is_member", {
            message:
              "That data owner is already a member of your organisation. External-client workspaces need a data owner outside your organisation; for internal collaborators, create an internal workspace instead.",
          });
      }

      const created = await db.transaction(async (tx) => {
        let accountId: string;
        if (separate) {
          accountId = await createWorkspaceAccount(tx, now, {
            createdBy: member.appUserId,
            label: `${name} billing`,
          });
        } else {
          accountId = await orgAccountForNewWorkspace(tx, now, orgId, member.appUserId);
          const account = await billingAccountById(tx, accountId);
          const blocked = blocksNewWorkspace(account);
          if (blocked) throw new PaymentRequiredError(blocked);
          if (
            !who.isStaff &&
            account?.tier === "free" &&
            (await countOrgWorkspaces(tx, orgId, accountId)) >= FREE_TIER_MAX_WORKSPACES
          )
            throw new PaymentRequiredError("billing.tier_limit", {
              message: "free tier limit",
              params: { limit: "workspaces" },
              details: freeTierLimit("workspaces"),
            });
        }
        if (body.visibility !== "open_to_organisation" && !who.isStaff) {
          const acct = await billingAccountById(tx, accountId);
          const tier = acct?.tier || "free";
          if (!["innovator", "changemaker", "guardian"].includes(tier))
            throw new PaymentRequiredError("workspace.visibility_requires_tier");
        }
        const wsId = newId();
        await insertWorkspace(tx, {
          id: wsId,
          org_id: orgId,
          name,
          visibility: body.visibility,
          is_default: false,
          created_by: member.appUserId,
          billing_account_id: accountId,
          usage_context: separate ? "external" : "internal",
          created_at: iso(now),
          updated_at: iso(now),
          ...(separate && {
            data_owner_org_name: dataOwnerOrgName,
            data_owner_email: dataOwnerEmail,
            partner_agreement_accepted_at: iso(now),
          }),
        });
        if (separate) await updateAccount(tx, now, accountId, { workspace_id: wsId });
        await insertMembership(tx, {
          id: newId(),
          workspace_id: wsId,
          user_id: member.appUserId,
          role: "owner",
          source: "direct",
          created_at: iso(now),
          updated_at: iso(now),
        });
        await reconcileSeats(deps.jobs, tx, accountId);
        // Its copy of the best-practices sample, seeded by the worker once this commits.
        await deps.jobs.enqueue(seedBestPracticesJob, { workspaceId: wsId }, { tx });
        if (separate && dataOwnerEmail) {
          await inviteDataOwner(tx, now, {
            workspaceId: wsId,
            workspaceName: name,
            orgName: dataOwnerOrgName ?? "",
            email: dataOwnerEmail,
            invitedBy: member.appUserId,
          });
        }
        const creator = await appUser(tx, member.appUserId);
        const creatorName = creator?.display_name || "A organisation admin";
        await emitToAll(tx, now, await orgAdmins(tx, orgId), {
          actor: member.appUserId,
          event: "WORKSPACE_CREATED",
          title: `${creatorName} created ${name}`,
          message:
            body.visibility === "open_to_organisation"
              ? "The new workspace is open to the organisation — discover it from your organisation page."
              : "The new workspace is restricted — organisation admins can join it; members can't see it.",
          action: "NAVIGATE_WS",
          workspaceId: wsId,
          orgId,
        });
        return wsId;
      });
      // New workspaces report "pilot" here, as the old API did; the frontend ignores it.
      return { id: created, name, org_id: orgId, tier: "pilot" };
    },

    /**
     * Soft delete, only when no live project is left; the sample copy does not count and is
     * deleted with the workspace. Admins and owners may; a staff support session may not
     * (spec M-6).
     */
    async remove(ctx: WorkspaceContext) {
      if (!ctx.allows("settings:manage") || ctx.isSupportSession)
        throw new ForbiddenError("workspace.delete_admin_only");
      const now = clock(deps);
      const count = await countLiveProjects(db, ctx.workspaceId);
      if (count > 0) throw new ConflictError("workspace.has_projects", { params: { count } });
      const ws = await workspaceById(db, ctx.workspaceId);
      await db.transaction(async (tx) => {
        await updateWorkspace(tx, ctx.workspaceId, { deleted_at: iso(now), updated_at: iso(now) });
        await deleteSampleProjects(tx, ctx.workspaceId, iso(now));
        const account = await billingAccountById(tx, ws?.billing_account_id);
        if (account) await reconcileSeats(deps.jobs, tx, account.id);
      });
      return { status: "deleted" };
    },

    /** Staff-only tier change; a downgrade applies its revert effects first (PATCH .../tier). */
    async setTier(who: Signed, workspaceId: string, body: { tier: string; reason: string }) {
      // A named, audited staff permission (spec H-14).
      await requireStaff(
        staffAudit,
        who,
        {
          permission: "staff:set_tier",
          action: "workspace.tier.update",
          targetType: "workspace",
          targetId: workspaceId,
          detail: { tier: body.tier, reason: body.reason },
        },
        "Staff-only action",
      );
      const now = clock(deps);
      const ws = await workspaceById(db, workspaceId);
      if (!ws || ws.deleted_at) throw new NotFoundError("workspace.not_found");
      const account = await billingAccountById(db, ws.billing_account_id);
      if (hasLiveMollieSubscription(account))
        throw new ConflictError("workspace.tier_change_active_subscription");
      const fromTier = account?.tier || "pioneer";
      const toTier = body.tier;
      const fromIdx = (TIER_ORDER as readonly string[]).indexOf(fromTier);
      const toIdx = (TIER_ORDER as readonly string[]).indexOf(toTier);
      if (fromIdx < 0 || toIdx < 0) throw new StatusError(500, "workspace.unknown_tier");
      const direction = fromIdx === toIdx ? "no-change" : toIdx > fromIdx ? "upgrade" : "downgrade";
      const effects = direction === "downgrade" ? downgradeEffects(fromTier, toTier) : [];
      const paymentMode = toTier === "free" ? "none" : "offline";

      await db.transaction(async (tx) => {
        if (effects.length) {
          if (effects.some((e) => e.effect === "revert" && e.policy === "workspace:whitelabel"))
            await updateWorkspace(tx, workspaceId, { logo_url: null, updated_at: iso(now) });
          await clearOverCapStamps(tx, workspaceId, iso(now));
        }
        if (account) {
          await updateAccount(tx, now, account.id, {
            tier: toTier,
            ...(direction === "downgrade" && {
              downgraded_at: iso(now),
              downgraded_from_tier: fromTier,
            }),
            ...(direction === "upgrade" && { downgraded_at: null, downgraded_from_tier: null }),
            payment_mode: paymentMode,
            ...(paymentMode === "offline" && { tier_expires_at: null, pre_warning_sent: false }),
          });
        }
        if (direction === "no-change") return;
        const wsName = ws.name || "your workspace";
        const audience = await workspaceAdmins(tx, workspaceId, ["admin", "owner", "billing"]);
        const human = effects
          .map((e) => e.human)
          .filter(Boolean)
          .join(", ");
        await emitToAll(tx, now, audience, {
          event: direction === "upgrade" ? "TIER_UPGRADED" : "TIER_DOWNGRADED",
          title:
            direction === "upgrade"
              ? `${wsName} upgraded to ${toTier}`
              : `${wsName} moved to ${toTier}`,
          message:
            direction === "upgrade"
              ? `You now have ${toTier}-tier features unlocked.`
              : human
                ? `Some features are now limited: ${human}.`
                : "Some features are now limited.",
          action: "NAVIGATE_WS",
          workspaceId,
        });
        if (direction === "downgrade" && audience.length) {
          // One email per language, each recipient in the one their dashboard is set to.
          const users = await appUsersByIds(tx, audience);
          const langs = await localesOfAppUsers(tx, audience);
          const byLocale = new Map<string, Set<string>>();
          for (const u of users) {
            const email = (u.email ?? "").trim();
            if (!email) continue;
            const l = langs.get(u.id) ?? "en-US";
            byLocale.set(l, (byLocale.get(l) ?? new Set()).add(email));
          }
          for (const [locale, set] of [...byLocale].sort(([a], [b]) => (a < b ? -1 : 1))) {
            const mail = tierDowngradedEmail(
              {
                workspaceName: wsName,
                fromTier,
                toTier,
                downgradedAtHuman: humanDate(now),
                freezeItems: effects.filter((e) => e.effect === "freeze").map((e) => e.human),
                revertItems: effects.filter((e) => e.effect === "revert").map((e) => e.human),
                workspaceUrl: dashboardPath(
                  deps.dashboardUrl,
                  `/w/${workspaceId}/settings/billing`,
                ),
              },
              locale,
            );
            await deps.jobs.enqueue(
              emailJob,
              { to: [...set].sort(), ...mail, tags: ["tier_downgraded"] },
              { tx },
            );
          }
        }
      });
      return {
        workspace_id: workspaceId,
        previous_tier: fromTier,
        new_tier: toTier,
        direction,
        payment_mode: paymentMode,
        effects_applied: effects,
      };
    },

    /** What a downgrade would do; read only, for the confirmation dialog. */
    previewDowngrade(ctx: WorkspaceContext, toTier: string) {
      ctx.require("settings:manage");
      const current = ctx.tier ?? "pioneer";
      return { from_tier: current, to_tier: toTier, effects: downgradeEffects(current, toTier) };
    },

    /** The public tier matrix. */
    tierCapacities() {
      return Object.values(TIER_CAPACITIES).map((c) => ({
        tier: c.tier,
        tagline: c.tagline,
        pricing: tierPricing(c.tier),
        billing_period_applicable: c.billingPeriodApplicable,
        duration: c.duration,
        included_seats: c.includedSeats,
        included_hours: c.includedHours,
        hard_block_on_hours: c.hardBlockOnHours,
        training_included: c.trainingIncluded,
      }));
    },

    /** Usage for one calendar month; financial fields only for those who see invoices. */
    async usage(ctx: WorkspaceContext, monthOffset: number) {
      ctx.require("workspace:view_usage");
      if (monthOffset < 0 || monthOffset > 12)
        throw new BadRequestError("request.month_offset_out_of_range");
      const now = clock(deps);
      const isCurrent = monthOffset === 0;
      const seesFinancials = ctx.allows("workspace:view_invoices");
      const [start, end] = monthBounds(now, monthOffset);
      const projects = await workspaceProjects(db, ctx.workspaceId);
      const ids = projects.map((p) => p.id);
      const cycle = await conversationDurationsIn(db, ids, pyIso(start), pyIso(end));
      const allTime = await allConversationDurations(db, ids);
      const hoursLifetime = pyRound(allTime.reduce((a, c) => a + (c.duration ?? 0), 0) / 3600, 2);
      const perSeconds = new Map<string, number>();
      const perCount = new Map<string, number>();
      let totalSeconds = 0;
      for (const c of cycle) {
        const sec = pyInt(c.duration);
        totalSeconds += sec;
        perSeconds.set(c.project_id, (perSeconds.get(c.project_id) ?? 0) + sec);
        perCount.set(c.project_id, (perCount.get(c.project_id) ?? 0) + 1);
      }
      const perProject = projects
        .filter((p) => !p.deleted_at || (perCount.get(p.id) ?? 0) > 0)
        .map((p) => ({
          id: p.id,
          name: p.name ?? "",
          audio_hours: pyRound((perSeconds.get(p.id) ?? 0) / 3600, 2),
          conversation_count: perCount.get(p.id) ?? 0,
        }));
      const audioHours = pyRound(totalSeconds / 3600, 2);
      const [seats, members, externals, observers] = seatState(
        await effectiveMembers(db, ctx.workspaceId),
      );
      const tier = ctx.tier ?? "";
      const cap = capacityOf(tier);
      const recommended = isCurrent ? nextTier(tier) : null;
      const rcap = recommended ? capacityOf(recommended) : null;
      const [mPending, ePending] = await countPendingInvites(db, ctx.workspaceId, iso(now));
      return {
        cycle_start: pyIso(start),
        cycle_end_exclusive: pyIso(end),
        tier,
        tier_tagline: cap?.tagline ?? "",
        audio_hours: audioHours,
        audio_hours_included: cap?.includedHours ?? null,
        seat_count: seats,
        seat_count_included: cap?.includedSeats ?? null,
        member_count: members,
        external_count: externals,
        observer_count: observers,
        pending_count: mPending + ePending,
        project_count: projects.filter((p) => !p.deleted_at).length,
        projects: perProject,
        pilot_hard_block_active: false,
        // No tier hard-caps seats any more (spec 4.1, CTO Q12).
        seat_invite_blocked: false,
        usage_gates: { ...usageGates(tier, hoursLifetime), upgrade_cta_tier: nextTier(tier) },
        next_tier:
          seesFinancials && recommended && rcap
            ? {
                tier: recommended,
                tagline: rcap.tagline,
                pricing: tierPricing(recommended),
                included_hours: rcap.includedHours,
                included_seats: rcap.includedSeats,
              }
            : null,
        free_tier: await freeTierBlock(db, tier, ids),
      };
    },

    /** The billing org's admin offers the workspace to a client org (matrix section 10). */
    async initiateHandoff(ctx: WorkspaceContext, body: { target_organisation_id: string }) {
      const now = clock(deps);
      const ws = await workspaceById(db, ctx.workspaceId);
      if (!ws) throw new NotFoundError("workspace.not_found");
      const billingOrg = ws.billed_to_team_id || ws.org_id;
      if (!billingOrg) throw new StatusError(500, "workspace.no_billing_org");
      if (!(await adminsOrg(billingOrg, ctx.who.appUserId)))
        throw new ForbiddenError("workspace.handoff_admin_only");
      await requireWorkspaceScopedBilling(ws);
      const target = body.target_organisation_id;
      if (target === billingOrg) throw new BadRequestError("workspace.handoff_same_org");
      const targetOrg = await orgById(db, target);
      if (!targetOrg || targetOrg.deleted_at)
        throw new NotFoundError("workspace.handoff_target_not_found");
      if (ws.handoff_status === "pending") throw new ConflictError("workspace.handoff_pending");
      await db.transaction(async (tx) => {
        await updateWorkspace(tx, ws.id, {
          handoff_status: "pending",
          handoff_target_team_id: target,
          updated_at: iso(now),
        });
        const wsName = ws.name || "a workspace";
        await emitToAll(tx, now, await orgAdmins(tx, target), {
          actor: ctx.who.appUserId,
          event: "PARTNER_HANDOFF_PENDING",
          title: `${wsName} is being handed to your organisation`,
          message: `A partner wants to hand ${wsName} over. Review the workspace and accept the handoff to start billing.`,
          action: "NAVIGATE_WS",
          workspaceId: ws.id,
          orgId: target,
        });
      });
      return { status: "pending", workspace_id: ws.id, handoff_target_team_id: target };
    },

    async acceptHandoff(ctx: WorkspaceContext) {
      const now = clock(deps);
      const ws = await workspaceById(db, ctx.workspaceId);
      if (!ws) throw new NotFoundError("workspace.not_found");
      if (ws.handoff_status !== "pending")
        throw new ConflictError("workspace.handoff_none_pending");
      const target = ws.handoff_target_team_id;
      if (!target) throw new StatusError(500, "workspace.handoff_inconsistent");
      if (!(await adminsOrg(target, ctx.who.appUserId)))
        throw new ForbiddenError("workspace.handoff_accept_target_admin_only");
      await requireWorkspaceScopedBilling(ws);
      const prior = ws.billed_to_team_id || ws.org_id;
      await db.transaction(async (tx) => {
        await updateWorkspace(tx, ws.id, {
          billed_to_team_id: target,
          effective_client_team_id: target,
          handoff_status: "completed",
          handoff_target_team_id: null,
          updated_at: iso(now),
        });
        const wsName = ws.name || "a workspace";
        if (prior) {
          await emitToAll(tx, now, await orgAdmins(tx, prior), {
            actor: ctx.who.appUserId,
            event: "PARTNER_HANDOFF_ACCEPTED",
            title: `${wsName} handoff completed`,
            message:
              "The client accepted. Billing has flipped; your organisation no longer pays this workspace's subscription.",
            action: "NAVIGATE_WS",
            workspaceId: ws.id,
            orgId: prior,
          });
        }
        await emitToAll(
          tx,
          now,
          (await orgAdmins(tx, target)).filter((u) => u !== ctx.who.appUserId),
          {
            actor: ctx.who.appUserId,
            event: "PARTNER_HANDOFF_ACCEPTED",
            title: `${wsName} is now yours`,
            message:
              "Your organisation now owns this workspace. Our team will coordinate the billing transfer with you. Nothing changes until then.",
            action: "NAVIGATE_WS",
            workspaceId: ws.id,
            orgId: target,
          },
        );
      });
      return { status: "completed", workspace_id: ws.id, handoff_target_team_id: null };
    },

    async cancelHandoff(ctx: WorkspaceContext) {
      const now = clock(deps);
      const ws = await workspaceById(db, ctx.workspaceId);
      if (!ws) throw new NotFoundError("workspace.not_found");
      if (ws.handoff_status !== "pending")
        throw new ConflictError("workspace.handoff_none_pending", {
          message: "No pending handoff to cancel",
        });
      const billingOrg = ws.billed_to_team_id || ws.org_id;
      if (!billingOrg || !(await adminsOrg(billingOrg, ctx.who.appUserId)))
        throw new ForbiddenError("workspace.handoff_cancel_initiator_only");
      await updateWorkspace(db, ws.id, {
        handoff_status: null,
        handoff_target_team_id: null,
        updated_at: iso(now),
      });
      return { status: "cancelled", workspace_id: ws.id, handoff_target_team_id: null };
    },
  };
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** strftime("%d %B %Y"), e.g. "07 September 2026". */
function humanDate(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
