import { BadRequestError, ForbiddenError } from "@dembrane/core";
import type { AccountStorage } from "./storage";

const EXPIRING_SOON_DAYS = 30;

export interface TrainingStatus {
  trained: boolean;
  trained_until: string | null;
  expiring_soon: boolean;
}

/**
 * The profile the dashboard loads on every page: onboarding state, org memberships,
 * pending invites, training licence and settings. Field names and defaults match
 * MeResponse in the Python API, which the frontend reads.
 */
export async function getMe(
  store: AccountStorage,
  who: { directusUserId: string; isStaff: boolean },
  now: Date,
) {
  const [appUser, profile, hasLegacyProjects] = await Promise.all([
    store.appUser(who.directusUserId),
    store.directusProfile(who.directusUserId),
    store.hasLegacyProjects(who.directusUserId),
  ]);
  const base = {
    id: null as string | null,
    directus_user_id: who.directusUserId,
    avatar: null as string | null,
    orgs: [] as { id: string; name: string; role: string; is_partner: boolean }[],
    has_pending_invites: false,
    is_staff: who.isStaff,
    has_legacy_projects: false,
    onboarding_answer_json: null as Record<string, unknown> | null,
    training_status: {
      trained: false,
      trained_until: null,
      expiring_soon: false,
    } as TrainingStatus,
    high_risk_context: false,
    settings: {} as Record<string, unknown>,
  };

  if (!profile) return { ...base, email: "", display_name: "", onboarding_completed: false };

  const email = profile.email ?? "";
  const displayName = `${profile.first ?? ""} ${profile.last ?? ""}`.trim() || email;
  if (!appUser) {
    return {
      ...base,
      email,
      display_name: displayName,
      avatar: profile.avatar ?? null,
      onboarding_completed: false,
      has_pending_invites: email ? await store.hasPendingInvites(email, now) : false,
      has_legacy_projects: hasLegacyProjects,
    };
  }

  const [hasPendingInvites, orgs, licenses] = await Promise.all([
    email ? store.hasPendingInvites(email, now) : Promise.resolve(false),
    store.orgSummaries(appUser.id),
    store.licenses(appUser.id),
  ]);
  const answers = isRecord(appUser.onboarding_answer_json) ? appUser.onboarding_answer_json : null;
  return {
    ...base,
    id: appUser.id,
    email: appUser.email || email,
    display_name: appUser.display_name || displayName,
    avatar: profile.avatar ?? null,
    onboarding_completed: true,
    orgs,
    has_pending_invites: hasPendingInvites,
    has_legacy_projects: hasLegacyProjects,
    onboarding_answer_json: answers,
    training_status: trainingStatus(licenses, now),
    high_risk_context: flagsHighRisk(answers?.data),
    settings: isRecord(appUser.settings) ? appUser.settings : {},
  };
}

/** The active licence with the furthest expiry wins; otherwise the latest one, shown as not trained. */
export function trainingStatus(
  rows: readonly { status: string | null; expiresAt: string | null }[],
  now: Date,
): TrainingStatus {
  const isActive = (r: (typeof rows)[number]) =>
    (r.status ?? "active") === "active" && r.expiresAt !== null && new Date(r.expiresAt) > now;
  const best = rows.find(isActive) ?? rows[0];
  if (!best) return { trained: false, trained_until: null, expiring_soon: false };
  const trained = isActive(best);
  const soon = new Date(now.getTime() + EXPIRING_SOON_DAYS * 86_400_000);
  return {
    trained,
    trained_until: trained ? best.expiresAt : null,
    expiring_soon: trained && best.expiresAt !== null && new Date(best.expiresAt) <= soon,
  };
}

/** Onboarding answer q2 of "yes"/"true" marks a high-risk use. Anything malformed reads as not high-risk. */
export function flagsHighRisk(answers: unknown): boolean {
  if (!Array.isArray(answers)) return false;
  return answers.some((a) => {
    if (!isRecord(a)) return false;
    const q2 = a.q2;
    return (
      q2 === true || (typeof q2 === "string" && ["yes", "true"].includes(q2.trim().toLowerCase()))
    );
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Updates display_name and merges settings keys into the stored settings. The merge runs
 * on a row lock so two tabs saving different keys at once keep both (the old API used a
 * Redis lock for the same reason).
 */
export async function updateMe(
  store: AccountStorage,
  who: { directusUserId: string },
  body: { display_name: string | null; settings: Record<string, unknown> | null },
  now: Date,
) {
  if (body.display_name === null && body.settings === null)
    throw new BadRequestError("request.nothing_to_update", { message: "Nothing to update" });
  const user = await store.appUser(who.directusUserId);
  if (!user) throw new ForbiddenError("access.not_onboarded");
  await store.updateAppUserLocked(user.id, now, (fresh) => {
    const patch: { display_name?: string; settings?: Record<string, unknown> } = {};
    // display_name lands in email subjects ("{inviter} invited you"), so CR/LF never pass.
    if (body.display_name !== null) patch.display_name = cleanName(body.display_name);
    if (body.settings !== null) {
      const existing = isRecord(fresh.settings) ? fresh.settings : {};
      patch.settings = { ...existing, ...body.settings };
    }
    return patch;
  });
  return { status: "success" };
}

export function cleanName(v: string): string {
  return v.replace(/\r/g, " ").replace(/\n/g, " ").trim();
}
