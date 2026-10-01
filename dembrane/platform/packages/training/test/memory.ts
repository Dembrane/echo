import type { LicenseRow, TrainingRow, TrainingStore, UserRow } from "../src";

/** In-memory twin of trainingStorage for the service tests. */
export class MemoryTrainingStore implements TrainingStore {
  users = new Map<string, UserRow>();
  memberships: { id: string; org_id: string; user_id: string; role: string; deleted?: boolean }[] =
    [];
  orgs = new Map<string, { id: string; name: string; deleted_at: string | null }>();
  staff: string[] = [];
  trainingsById = new Map<string, TrainingRow>();
  licenses = new Map<string, LicenseRow>();

  async appUser(id: string) {
    return this.users.get(id) ?? null;
  }
  async appUsers(ids: readonly string[]) {
    return [...this.users.values()].filter((u) => ids.includes(u.id));
  }
  private live(orgId: string) {
    return this.memberships
      .filter((m) => m.org_id === orgId && !m.deleted)
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  async orgRole(orgId: string, appUserId: string) {
    return this.live(orgId).find((m) => m.user_id === appUserId)?.role ?? null;
  }
  async orgMemberships(orgId: string) {
    return this.live(orgId).map((m) => ({ user_id: m.user_id, role: m.role }));
  }
  async org(id: string) {
    return this.orgs.get(id) ?? null;
  }
  async orgNames(ids: readonly string[]) {
    return new Map(
      ids.flatMap((i) => (this.orgs.has(i) ? [[i, this.orgs.get(i)?.name ?? ""]] : [])) as [
        string,
        string,
      ][],
    );
  }
  async orgMemberCounts(ids: readonly string[]) {
    return new Map(ids.map((i) => [i, this.live(i).length]));
  }
  async staffAppUserIds() {
    return [...this.staff];
  }
  async training(id: string) {
    const t = this.trainingsById.get(id);
    return t ? { ...t } : null;
  }
  async trainings(f: { orgId?: string; status?: string }) {
    return [...this.trainingsById.values()]
      .filter((t) => (!f.orgId || t.org_id === f.orgId) && (!f.status || t.status === f.status))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }
  async insertTraining(row: TrainingRow) {
    this.trainingsById.set(row.id, { ...row });
  }
  async updateTraining(id: string, patch: Partial<TrainingRow>) {
    const t = this.trainingsById.get(id);
    if (t) this.trainingsById.set(id, { ...t, ...patch });
  }
  async license(id: string) {
    const l = this.licenses.get(id);
    return l ? { ...l } : null;
  }
  async insertLicense(row: LicenseRow) {
    this.licenses.set(row.id, { ...row });
  }
  async updateLicense(id: string, patch: Partial<LicenseRow>) {
    const l = this.licenses.get(id);
    if (l) this.licenses.set(id, { ...l, ...patch });
  }
  private sortedByExpiry(rows: LicenseRow[]) {
    return rows.sort((a, b) => String(b.expires_at).localeCompare(String(a.expires_at)));
  }
  async licensesOfUser(appUserId: string) {
    return this.sortedByExpiry(
      [...this.licenses.values()].filter((l) => l.app_user_id === appUserId),
    );
  }
  async licensesOfOrgUsers(orgId: string, userIds: readonly string[]) {
    return this.sortedByExpiry(
      [...this.licenses.values()].filter(
        (l) => l.org_id === orgId && l.app_user_id !== null && userIds.includes(l.app_user_id),
      ),
    );
  }
  async licensesOfTraining(trainingId: string) {
    return [...this.licenses.values()]
      .filter((l) => l.training_id === trainingId)
      .sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at)));
  }
  async activeLicenseCounts(ids: readonly string[]) {
    return new Map(
      ids.map((i) => [
        i,
        [...this.licenses.values()].filter((l) => l.training_id === i && l.status === "active")
          .length,
      ]),
    );
  }
}
