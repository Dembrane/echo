import type { Db } from "@echo/db";
import { schema } from "@echo/db";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { TrainingStore } from "./store";

const { training, training_license, app_user, org, org_membership } = schema;

export function trainingStorage(db: Db): TrainingStore {
  const users = { id: app_user.id, display_name: app_user.display_name, email: app_user.email };
  return {
    async appUser(id) {
      const [r] = await db.select(users).from(app_user).where(eq(app_user.id, id));
      return r ?? null;
    },
    async appUsers(ids) {
      if (!ids.length) return [];
      return db
        .select(users)
        .from(app_user)
        .where(inArray(app_user.id, [...ids]));
    },
    async orgRole(orgId, appUserId) {
      const [r] = await db
        .select({ role: org_membership.role })
        .from(org_membership)
        .where(
          and(
            eq(org_membership.org_id, orgId),
            eq(org_membership.user_id, appUserId),
            isNull(org_membership.deleted_at),
          ),
        )
        .orderBy(asc(org_membership.id))
        .limit(1);
      return r ? r.role : null;
    },
    async orgMemberships(orgId) {
      return db
        .select({ user_id: org_membership.user_id, role: org_membership.role })
        .from(org_membership)
        .where(and(eq(org_membership.org_id, orgId), isNull(org_membership.deleted_at)))
        .orderBy(asc(org_membership.id));
    },
    async org(id) {
      const [r] = await db
        .select({ id: org.id, name: org.name, deleted_at: org.deleted_at })
        .from(org)
        .where(eq(org.id, id));
      return r ?? null;
    },
    async orgNames(ids) {
      if (!ids.length) return new Map();
      const rows = await db
        .select({ id: org.id, name: org.name })
        .from(org)
        .where(inArray(org.id, [...ids]));
      return new Map(rows.map((r) => [r.id, r.name ?? ""]));
    },
    async orgMemberCounts(ids) {
      const out = new Map<string, number>(ids.map((i) => [i, 0]));
      if (!ids.length) return out;
      const rows = await db
        .select({ org_id: org_membership.org_id, n: sql<number>`count(*)::int` })
        .from(org_membership)
        .where(and(inArray(org_membership.org_id, [...ids]), isNull(org_membership.deleted_at)))
        .groupBy(org_membership.org_id);
      for (const r of rows) out.set(r.org_id, r.n);
      return out;
    },
    async staffAppUserIds() {
      const { directus_users, directus_access, directus_policies } = schema;
      const rows = await db
        .selectDistinct({ id: app_user.id })
        .from(app_user)
        .innerJoin(directus_users, eq(directus_users.id, app_user.directus_user_id))
        .innerJoin(
          directus_access,
          or(
            eq(directus_access.user, directus_users.id),
            eq(directus_access.role, directus_users.role),
          ),
        )
        .innerJoin(directus_policies, eq(directus_policies.id, directus_access.policy))
        .where(eq(directus_policies.admin_access, true))
        .orderBy(asc(app_user.id));
      return rows.map((r) => r.id);
    },
    async training(id) {
      const [r] = await db.select().from(training).where(eq(training.id, id));
      return r ?? null;
    },
    async trainings(f) {
      const conds = [];
      if (f.orgId) conds.push(eq(training.org_id, f.orgId));
      if (f.status) conds.push(eq(training.status, f.status));
      return db
        .select()
        .from(training)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(training.created_at), asc(training.id));
    },
    async insertTraining(row) {
      await db.insert(training).values(row);
    },
    async updateTraining(id, patch) {
      await db.update(training).set(patch).where(eq(training.id, id));
    },
    async license(id) {
      const [r] = await db.select().from(training_license).where(eq(training_license.id, id));
      return r ?? null;
    },
    async insertLicense(row) {
      await db.insert(training_license).values(row);
    },
    async updateLicense(id, patch) {
      await db.update(training_license).set(patch).where(eq(training_license.id, id));
    },
    async licensesOfUser(appUserId) {
      return db
        .select()
        .from(training_license)
        .where(eq(training_license.app_user_id, appUserId))
        .orderBy(desc(training_license.expires_at), asc(training_license.id));
    },
    async licensesOfOrgUsers(orgId, userIds) {
      if (!userIds.length) return [];
      return db
        .select()
        .from(training_license)
        .where(
          and(
            eq(training_license.org_id, orgId),
            inArray(training_license.app_user_id, [...userIds]),
          ),
        )
        .orderBy(desc(training_license.expires_at), asc(training_license.id));
    },
    async licensesOfTraining(trainingId) {
      return db
        .select()
        .from(training_license)
        .where(eq(training_license.training_id, trainingId))
        .orderBy(desc(training_license.completed_at), asc(training_license.id));
    },
    async activeLicenseCounts(ids) {
      const out = new Map<string, number>(ids.map((i) => [i, 0]));
      if (!ids.length) return out;
      const rows = await db
        .select({ training_id: training_license.training_id, n: sql<number>`count(*)::int` })
        .from(training_license)
        .where(
          and(
            inArray(training_license.training_id, [...ids]),
            eq(training_license.status, "active"),
          ),
        )
        .groupBy(training_license.training_id);
      for (const r of rows) if (r.training_id) out.set(r.training_id, r.n);
      return out;
    },
  };
}
