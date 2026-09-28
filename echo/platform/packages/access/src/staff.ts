import { ForbiddenError, newId } from "@echo/core";
import type { Db } from "@echo/db";
import { schema } from "@echo/db";

/**
 * Named staff permissions (CTO decision 8.5): each staff capability is granted on its
 * own, instead of the blanket Directus admin flag, and every use is audited. Customer
 * project data is never read through these; staff reach it only through a support
 * session (a staff_support workspace membership resolved like any other).
 */
export const STAFF_POLICIES = [
  /** Billing rollups, payments, discounts, trials, managed accounts, any org's billing. */
  "staff:billing",
  /** Change a workspace's or billing account's tier. */
  "staff:set_tier",
  /** Org partner flag, workspace member list, change admin, reset usage. */
  "staff:workspaces",
  /** Self-join a customer workspace for support, and request that access. */
  "staff:support_join",
  /** Training catalog, licences and completions. */
  "staff:training",
  /** Read every user's feedback and the attachments of any report. */
  "staff:feedback",
  /** Customer accounts: documents, tasks, tickets, invoice mirrors, stage (sam's staff key). */
  "staff:accounts",
] as const;

export type StaffPolicy = (typeof STAFF_POLICIES)[number];

/** What a caller carries for staff decisions. `staffPolicies`, once stored, replaces the derivation. */
export interface StaffSubject {
  readonly directusUserId: string;
  readonly isStaff: boolean;
  readonly staffPolicies?: readonly StaffPolicy[];
}

/**
 * The staff permissions a caller holds. Until a per-user store exists, a Directus
 * Administrator holds all of them and nobody else holds any, which is exactly who
 * passes `auth.is_admin` today, so behaviour is unchanged while every use is named.
 */
export function staffPoliciesOf(who: StaffSubject | null): ReadonlySet<StaffPolicy> {
  if (!who) return new Set();
  if (who.staffPolicies) return new Set(who.staffPolicies);
  return new Set(who.isStaff ? STAFF_POLICIES : []);
}

export function hasStaffPolicy(who: StaffSubject | null, policy: StaffPolicy): boolean {
  return staffPoliciesOf(who).has(policy);
}

export interface StaffAuditEntry {
  readonly permission: StaffPolicy;
  /** What was done, as a stable verb phrase, e.g. "billing_account.discount.update". */
  readonly action: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly detail?: Record<string, unknown>;
  readonly requestId?: string;
}

/** Durable trail of staff actions. One Drizzle implementation, one in-memory twin for tests. */
export interface StaffAudit {
  record(who: StaffSubject, entry: StaffAuditEntry): Promise<void>;
}

export class DrizzleStaffAudit implements StaffAudit {
  constructor(private readonly db: Db) {}
  async record(who: StaffSubject, e: StaffAuditEntry): Promise<void> {
    await this.db.insert(schema.staff_audit_event).values({
      id: newId(),
      staffUserId: who.directusUserId,
      permission: e.permission,
      action: e.action,
      targetType: e.targetType ?? null,
      targetId: e.targetId ?? null,
      detail: e.detail ?? null,
      requestId: e.requestId ?? null,
    });
  }
}

export class MemoryStaffAudit implements StaffAudit {
  entries: (StaffAuditEntry & { staffUserId: string })[] = [];
  async record(who: StaffSubject, e: StaffAuditEntry): Promise<void> {
    this.entries.push({ ...e, staffUserId: who.directusUserId });
  }
}

/**
 * Checks a staff permission and records its use before the action runs, so an action
 * that fails half way is still on the trail. Denial answers 403 with the detail the
 * old route sent ("Staff-only" on the admin surface).
 */
export async function requireStaff(
  audit: StaffAudit,
  who: StaffSubject | null,
  entry: StaffAuditEntry,
  denied = "Staff-only",
): Promise<void> {
  if (!who || !hasStaffPolicy(who, entry.permission)) throw new ForbiddenError(denied);
  await audit.record(who, entry);
}
