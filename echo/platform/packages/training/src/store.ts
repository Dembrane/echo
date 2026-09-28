import type { schema } from "@dembrane/db";

export type TrainingRow = typeof schema.training.$inferSelect;
export type LicenseRow = typeof schema.training_license.$inferSelect;
export type TrainingPatch = Partial<Omit<TrainingRow, "id">>;
export type LicensePatch = Partial<Omit<LicenseRow, "id">>;

export interface UserRow {
  readonly id: string;
  readonly display_name: string | null;
  readonly email: string | null;
}

/**
 * The rows training reads and writes, with the Directus query semantics the old routes
 * relied on: primary-key order unless sorted, expiry and completion sorted newest first
 * (nulls first, as Postgres sorts descending).
 */
export interface TrainingStore {
  appUser(id: string): Promise<UserRow | null>;
  appUsers(ids: readonly string[]): Promise<UserRow[]>;
  /** The caller's first active org membership role, or null. */
  orgRole(orgId: string, appUserId: string): Promise<string | null>;
  /** Active org memberships in id order. */
  orgMemberships(orgId: string): Promise<{ user_id: string; role: string }[]>;
  org(id: string): Promise<{ id: string; name: string; deleted_at: string | null } | null>;
  orgNames(ids: readonly string[]): Promise<Map<string, string>>;
  /** Active membership counts per org. */
  orgMemberCounts(ids: readonly string[]): Promise<Map<string, number>>;
  /** App users of the Directus accounts that hold an admin-access policy (staff). */
  staffAppUserIds(): Promise<string[]>;

  training(id: string): Promise<TrainingRow | null>;
  trainings(filter: { orgId?: string; status?: string }): Promise<TrainingRow[]>;
  insertTraining(row: TrainingRow): Promise<void>;
  updateTraining(id: string, patch: TrainingPatch): Promise<void>;

  license(id: string): Promise<LicenseRow | null>;
  insertLicense(row: LicenseRow): Promise<void>;
  updateLicense(id: string, patch: LicensePatch): Promise<void>;
  licensesOfUser(appUserId: string): Promise<LicenseRow[]>;
  licensesOfOrgUsers(orgId: string, userIds: readonly string[]): Promise<LicenseRow[]>;
  licensesOfTraining(trainingId: string): Promise<LicenseRow[]>;
  /** Active licences per training. */
  activeLicenseCounts(trainingIds: readonly string[]): Promise<Map<string, number>>;
}
