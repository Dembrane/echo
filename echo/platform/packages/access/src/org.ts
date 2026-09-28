/**
 * What an organisation role may do on the organisation's customer account:
 * agreements, billing details, tasks, support and invoices. Org admins and owners run the
 * account; the billing role handles it too, since signing and paying is their job. Plain
 * members see nothing of it: contracts and invoices are not every member's business.
 */
export const ORG_POLICIES = [
  "account:read",
  "account:sign",
  "account:billing",
  "account:tasks",
  "account:support",
] as const;

export type OrgPolicy = (typeof ORG_POLICIES)[number];

export const ORG_ROLES = ["member", "billing", "admin", "owner"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

const ACCOUNT: ReadonlySet<OrgPolicy> = new Set(ORG_POLICIES);

export const ORG_ROLE_POLICIES: Record<OrgRole, ReadonlySet<OrgPolicy>> = {
  member: new Set(),
  billing: ACCOUNT,
  admin: ACCOUNT,
  owner: ACCOUNT,
};

export function orgRoleHas(role: string | null, policy: OrgPolicy): boolean {
  if (!role || !(ORG_ROLES as readonly string[]).includes(role)) return false;
  return ORG_ROLE_POLICIES[role as OrgRole].has(policy);
}
