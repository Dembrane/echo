import type { Notifier } from "@dembrane/billing";
import { BadRequestError, ForbiddenError, NotFoundError, newId } from "@dembrane/core";
import { directusTime } from "@dembrane/legacy-shape";
import type { Mailer } from "@dembrane/mail";
import { escapeHtml } from "@dembrane/mail";
import type { Logger } from "@dembrane/observability";
import {
  CATALOG,
  computeExpiresAt,
  getProduct,
  isRequestable,
  licenseIsActive,
  parseIso,
  pyIsoformat,
  rosterTrainingMap,
} from "./catalog";
import type { LicensePatch, LicenseRow, TrainingPatch, TrainingRow, TrainingStore } from "./store";

/** Training requests land with the person who runs the training pipeline. */
export const TRAINING_NOTIFY_EMAIL = "pauline@dembrane.com";

export interface TrainingDeps {
  readonly store: TrainingStore;
  readonly notifier: Notifier;
  readonly mailer: Mailer;
  readonly logger: Logger;
  /** Dashboard origin for the review link in the staff email. */
  readonly dashboardUrl: string;
  readonly clock: () => Date;
}

const num = (v: number | null | undefined) => (v === null || v === undefined ? null : v);

export function catalog() {
  return CATALOG.map((p) => ({ ...p }));
}

/** The caller's org role, or 403. `admin` also requires admin or owner. */
export async function requireOrgRole(
  store: TrainingStore,
  orgId: string,
  appUserId: string,
  minimum: "member" | "admin",
): Promise<string> {
  const role = await store.orgRole(orgId, appUserId);
  if (role === null) throw new ForbiddenError("organisation.no_access");
  if (minimum === "admin" && role !== "admin" && role !== "owner")
    throw new ForbiddenError("organisation.admin_only");
  return role;
}

interface RosterMember {
  app_user_id: string;
  display_name: string;
  email: string | null;
  role: string;
  trained: boolean;
  trained_until: string | null;
  expiring_soon: boolean;
}

/**
 * Org members with trained or not-trained status, sorted by name. Emails follow the
 * org members redaction rule: shown to admins and owners, and to each member for
 * themselves; `showEmail` decides per member.
 */
async function roster(
  d: TrainingDeps,
  orgId: string,
  showEmail: (uid: string) => boolean,
): Promise<{ trained: number; members: RosterMember[] }> {
  const memberships = await d.store.orgMemberships(orgId);
  // A user with two rows keeps the first position and the last role, like a dict build.
  const roleByUser = new Map<string, string>();
  for (const m of memberships) if (m.user_id) roleByUser.set(m.user_id, m.role ?? "member");
  const userIds = [...roleByUser.keys()];
  if (!userIds.length) return { trained: 0, members: [] };
  const users = new Map((await d.store.appUsers(userIds)).map((u) => [u.id, u]));
  const status = rosterTrainingMap(
    userIds,
    await d.store.licensesOfOrgUsers(orgId, userIds),
    d.clock(),
  );
  let trained = 0;
  const members = userIds.map((uid) => {
    const u = users.get(uid);
    const st = status.get(uid);
    if (st?.trained) trained += 1;
    return {
      app_user_id: uid,
      display_name: u?.display_name || "",
      email: showEmail(uid) ? (u?.email ?? null) : null,
      role: roleByUser.get(uid) ?? "member",
      trained: Boolean(st?.trained),
      trained_until: directusTime(st?.trained_until ?? null),
      expiring_soon: Boolean(st?.expiring_soon),
    };
  });
  members.sort((a, b) => pyLess(a.display_name.toLowerCase(), b.display_name.toLowerCase()));
  return { trained, members };
}

/** Python string ordering (code points), not locale collation. */
function pyLess(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export async function orgRoster(d: TrainingDeps, orgId: string, appUserId: string) {
  const role = await requireOrgRole(d.store, orgId, appUserId, "member");
  const canManage = role === "admin" || role === "owner";
  const r = await roster(d, orgId, (uid) => canManage || uid === appUserId);
  return {
    org_id: orgId,
    trained_count: r.trained,
    total_count: r.members.length,
    can_manage: canManage,
    members: r.members,
  };
}

export async function staffOrgRoster(d: TrainingDeps, orgId: string) {
  const r = await roster(d, orgId, () => true);
  return {
    org_id: orgId,
    trained_count: r.trained,
    total_count: r.members.length,
    members: r.members,
  };
}

/**
 * An org admin asks for a training. Creates it as requested and tells staff in the
 * inbox and the training owner by email; both notices are best effort.
 */
export async function requestTraining(
  d: TrainingDeps,
  orgId: string,
  requester: { id: string },
  body: { type: string; extra_participants: number; notes: string | null },
) {
  await requireOrgRole(d.store, orgId, requester.id, "admin");
  if (!isRequestable(body.type)) throw new BadRequestError("training.not_available");
  const product = getProduct(body.type);
  if (!product) throw new BadRequestError("training.unknown_type");
  const extra = product.extra_price_eur;
  const estimated = product.price_eur + (extra ?? 0) * body.extra_participants;
  const now = d.clock();
  const nowIso = pyIsoformat(now);
  const id = newId();
  await d.store.insertTraining({
    id,
    org_id: orgId,
    type: product.type,
    included_participants: product.included_participants,
    extra_participants: body.extra_participants,
    base_price_eur: product.price_eur,
    extra_price_eur: extra,
    grants_license: product.grants_license,
    scheduled_at: null,
    status: "requested",
    notes: body.notes,
    requested_by: requester.id,
    created_at: nowIso,
    updated_at: nowIso,
  });

  const orgName = (await d.store.org(orgId))?.name || "an organisation";
  const user = await d.store.appUser(requester.id);
  const requesterName = user?.display_name || user?.email || "Someone";
  try {
    await d.notifier.emitToAudience(
      await d.store.staffAppUserIds(),
      {
        eventCode: "TRAINING_REQUESTED",
        title: `${orgName} requested a ${product.name} training`,
        message: `${requesterName} requested a ${product.name} training (${body.extra_participants} extra participants). Schedule and provision it.`,
        action: "NAVIGATE_TRAINING",
        actorUserId: requester.id,
        refOrgId: orgId,
      },
      now,
    );
  } catch (err) {
    d.logger.error({ err, orgId }, "training request staff inbox notify failed");
  }
  try {
    const base = d.dashboardUrl.replace(/\/+$/, "");
    const reviewUrl = base ? `${base}/admin/training` : "/admin/training";
    const text = [
      `${requesterName} requested a ${product.name} training for ${orgName}.`,
      `Extra participants: ${body.extra_participants}`,
      `Estimated total: EUR ${estimated.toFixed(0)}`,
      `Notes: ${body.notes || "(none)"}`,
      "",
      `Review and provision: ${reviewUrl}`,
    ].join("\n");
    await d.mailer.send({
      to: TRAINING_NOTIFY_EMAIL,
      subject: `Training requested: ${product.name} for ${orgName}`.replace(/[\r\n]/g, " "),
      text,
      html: `<pre style="font-family:inherit; white-space:pre-wrap;">${escapeHtml(text)}</pre>`,
      tags: ["training_requested"],
    });
  } catch (err) {
    d.logger.error({ err, orgId }, "training request email failed");
  }
  return {
    training_id: id,
    status: "requested",
    type: product.type,
    base_price_eur: product.price_eur,
    extra_price_eur: num(extra),
    estimated_total_eur: estimated,
  };
}

/** The caller's own licences, newest expiry first, each with whether it still counts. */
export async function myLicenses(d: TrainingDeps, appUserId: string) {
  const now = d.clock();
  return (await d.store.licensesOfUser(appUserId)).map((r) => ({
    id: r.id,
    org_id: r.org_id,
    training_id: r.training_id,
    completed_at: directusTime(r.completed_at),
    expires_at: directusTime(r.expires_at),
    status: r.status || "active",
    active: licenseIsActive(r, now),
  }));
}

function trainingOut(
  r: TrainingRow,
  extra: {
    org_name: string | null;
    requested_by_name: string | null;
    requested_by_email: string | null;
    license_count: number;
    org_member_count: number;
  },
) {
  return {
    id: r.id,
    org_id: r.org_id,
    org_name: extra.org_name,
    type: r.type || "",
    included_participants: Math.trunc(r.included_participants || 0),
    extra_participants: Math.trunc(r.extra_participants || 0),
    base_price_eur: num(r.base_price_eur),
    extra_price_eur: num(r.extra_price_eur),
    grants_license: Boolean(r.grants_license),
    scheduled_at: directusTime(r.scheduled_at),
    status: r.status || "",
    notes: r.notes,
    requested_by: r.requested_by,
    requested_by_name: extra.requested_by_name,
    requested_by_email: extra.requested_by_email,
    created_at: directusTime(r.created_at),
    updated_at: directusTime(r.updated_at),
    license_count: extra.license_count,
    org_member_count: extra.org_member_count,
  };
}

/** Every training, newest first, with org names, member counts and active licences. */
export async function listTrainings(d: TrainingDeps, f: { orgId?: string; status?: string }) {
  const rows = await d.store.trainings(f);
  if (!rows.length) return [];
  const orgIds = [...new Set(rows.map((r) => r.org_id).filter((x): x is string => Boolean(x)))];
  const names = await d.store.orgNames(orgIds);
  const counts = await d.store.orgMemberCounts(orgIds);
  const requesterIds = [
    ...new Set(rows.map((r) => r.requested_by).filter((x): x is string => Boolean(x))),
  ];
  const requesters = new Map((await d.store.appUsers(requesterIds)).map((u) => [u.id, u]));
  const licenses = await d.store.activeLicenseCounts(rows.map((r) => r.id));
  return rows.map((r) => {
    const u = r.requested_by ? requesters.get(r.requested_by) : undefined;
    return trainingOut(r, {
      org_name: r.org_id ? (names.get(r.org_id) ?? null) : null,
      requested_by_name: u?.display_name ?? null,
      requested_by_email: u?.email ?? null,
      license_count: licenses.get(r.id) ?? 0,
      org_member_count: r.org_id ? (counts.get(r.org_id) ?? 0) : 0,
    });
  });
}

/** Staff provision a training for an org from the catalog; the base price may be overridden. */
export async function createTraining(
  d: TrainingDeps,
  body: {
    org_id: string;
    type: string;
    extra_participants: number;
    scheduled_at: string | null;
    notes: string | null;
    base_price_eur: number | null;
  },
  orgExists: boolean,
) {
  const product = getProduct(body.type);
  if (!product) throw new BadRequestError("training.unknown_type");
  const org = orgExists ? await d.store.org(body.org_id) : null;
  if (!org || org.deleted_at) throw new NotFoundError("organisation.not_found");
  const base = body.base_price_eur ?? product.price_eur;
  const nowIso = pyIsoformat(d.clock());
  const id = newId();
  const status = body.scheduled_at ? "scheduled" : "requested";
  await d.store.insertTraining({
    id,
    org_id: body.org_id,
    type: product.type,
    included_participants: product.included_participants,
    extra_participants: body.extra_participants,
    base_price_eur: base,
    extra_price_eur: product.extra_price_eur,
    grants_license: product.grants_license,
    scheduled_at: body.scheduled_at,
    status,
    notes: body.notes,
    requested_by: null,
    created_at: nowIso,
    updated_at: nowIso,
  });
  return {
    id,
    org_id: body.org_id,
    org_name: org.name,
    type: product.type,
    included_participants: product.included_participants,
    extra_participants: body.extra_participants,
    base_price_eur: base,
    extra_price_eur: num(product.extra_price_eur),
    grants_license: product.grants_license,
    scheduled_at: body.scheduled_at,
    status,
    notes: body.notes,
    requested_by: null,
    requested_by_name: null,
    requested_by_email: null,
    created_at: nowIso,
    updated_at: nowIso,
    license_count: 0,
    org_member_count: 0,
  };
}

export async function updateTraining(
  d: TrainingDeps,
  id: string | null,
  body: {
    type?: string | null;
    status?: string | null;
    scheduled_at?: string | null;
    extra_participants?: number | null;
    notes?: string | null;
  },
) {
  const existing = id ? await d.store.training(id) : null;
  if (!existing) throw new NotFoundError("training.not_found");
  const patch: TrainingPatch = { updated_at: pyIsoformat(d.clock()) };
  if (body.type != null) {
    const product = getProduct(body.type);
    if (!product) throw new BadRequestError("training.unknown_type");
    patch.type = body.type;
    patch.grants_license = product.grants_license;
    patch.included_participants = product.included_participants;
  }
  if (body.status != null) patch.status = body.status;
  if (body.scheduled_at != null) patch.scheduled_at = body.scheduled_at;
  if (body.extra_participants != null) patch.extra_participants = body.extra_participants;
  if (body.notes != null) patch.notes = body.notes;
  await d.store.updateTraining(existing.id, patch);
  return { status: "success" };
}

/** The licences a training granted, with attendee names, newest completion first. */
export async function trainingLicenses(d: TrainingDeps, trainingId: string | null) {
  if (!trainingId) return [];
  const rows = await d.store.licensesOfTraining(trainingId);
  if (!rows.length) return [];
  const ids = [...new Set(rows.map((r) => r.app_user_id).filter((x): x is string => Boolean(x)))];
  const users = new Map((await d.store.appUsers(ids)).map((u) => [u.id, u]));
  return rows.map((r) => {
    const u = r.app_user_id ? users.get(r.app_user_id) : undefined;
    return {
      id: r.id,
      app_user_id: r.app_user_id ?? "",
      app_user_name: u?.display_name ?? null,
      app_user_email: u?.email ?? null,
      status: r.status ?? "",
      completed_at: directusTime(r.completed_at),
      expires_at: directusTime(r.expires_at),
    };
  });
}

/**
 * Marks attendees trained: one licence per user expiring a year after completion
 * (never set by hand), a notice to each, and the training flips to completed.
 */
export async function completeTraining(
  d: TrainingDeps,
  trainingId: string | null,
  staffAppUserId: string,
  body: { app_user_ids: string[]; completed_at: string | null },
) {
  const t = trainingId ? await d.store.training(trainingId) : null;
  if (!t) throw new NotFoundError("training.not_found");
  if (!t.grants_license) throw new BadRequestError("training.no_license");
  const completed = parseIso(body.completed_at) ?? d.clock();
  const ids: string[] = [];
  for (const uid of body.app_user_ids) {
    const id = newId();
    await d.store.insertLicense({
      id,
      training_id: t.id,
      org_id: t.org_id,
      app_user_id: uid,
      completed_at: pyIsoformat(completed),
      expires_at: pyIsoformat(computeExpiresAt(completed)),
      status: "active",
      granted_by: staffAppUserId,
      created_at: pyIsoformat(d.clock()),
    });
    ids.push(id);
    await d.notifier.emit(
      uid,
      {
        eventCode: "TRAINING_COMPLETED",
        title: "Your training is complete",
        message: "You now hold a one-year license to use dembrane in high-risk settings.",
        action: "NAVIGATE_TRAINING",
        actorUserId: staffAppUserId,
        refOrgId: t.org_id,
      },
      d.clock(),
    );
  }
  await d.store.updateTraining(t.id, { status: "completed", updated_at: pyIsoformat(d.clock()) });
  return { status: "success", license_ids: ids, licenses_created: ids.length };
}

/** Edits a licence's completion date (expiry follows) or status. */
export async function updateLicense(
  d: TrainingDeps,
  id: string | null,
  body: { completed_at?: string | null; status?: string | null },
) {
  const existing = id ? await d.store.license(id) : null;
  if (!existing) throw new NotFoundError("training.license_not_found");
  const patch: LicensePatch = {};
  if (body.completed_at != null) {
    const completed = parseIso(body.completed_at);
    if (!completed) throw new BadRequestError("training.completed_at_invalid");
    patch.completed_at = pyIsoformat(completed);
    patch.expires_at = pyIsoformat(computeExpiresAt(completed));
  }
  if (body.status != null) patch.status = body.status;
  if (!Object.keys(patch).length)
    throw new BadRequestError("request.nothing_to_update", { message: "Nothing to update" });
  await d.store.updateLicense(existing.id, patch);
  const merged: LicenseRow = { ...existing, ...patch };
  return {
    id: existing.id,
    org_id: merged.org_id,
    training_id: merged.training_id,
    app_user_id: merged.app_user_id ?? "",
    completed_at: directusTime(merged.completed_at),
    expires_at: directusTime(merged.expires_at),
    status: merged.status ?? "active",
    granted_by: merged.granted_by,
  };
}

/**
 * Revokes a licence. When the training has no active licence left it is no longer
 * completed: back to scheduled if dated, otherwise requested.
 */
export async function revokeLicense(d: TrainingDeps, id: string | null) {
  const existing = id ? await d.store.license(id) : null;
  if (!existing) throw new NotFoundError("training.license_not_found");
  await d.store.updateLicense(existing.id, { status: "revoked" });
  if (existing.training_id) {
    const left = (await d.store.activeLicenseCounts([existing.training_id])).get(
      existing.training_id,
    );
    if (!left) {
      const t = await d.store.training(existing.training_id);
      if (t?.status === "completed")
        await d.store.updateTraining(t.id, {
          status: t.scheduled_at ? "scheduled" : "requested",
          updated_at: pyIsoformat(d.clock()),
        });
    }
  }
  return { status: "success" };
}
