/**
 * What each workspace role may do. The source of truth for every access decision;
 * docs/access-model-current.md section 2.4 is what this replaces, with the intent of the
 * presets kept where effective behaviour drifted (workspace billing users get no project data).
 */
export const POLICIES = [
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
] as const;

export type Policy = (typeof POLICIES)[number];

export const WORKSPACE_ROLES = [
  "observer",
  "external",
  "member",
  "billing",
  "admin",
  "owner",
] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** Rank used by escalation guards: nobody grants a role above their own. */
export const ROLE_RANK: Record<WorkspaceRole, number> = {
  observer: 0,
  external: 1,
  member: 2,
  billing: 3,
  admin: 4,
  owner: 5,
};

const READ: Policy[] = ["project:read", "conversation:read", "report:view"];
const CONTRIBUTE: Policy[] = ["project:update", "chat:use", "report:generate"];
const MANAGE: Policy[] = [
  "project:delete",
  "project:share",
  "project:set_private",
  "project:move",
  "report:delete",
  "member:invite",
  "member:manage",
  "settings:manage",
  "workspace:export",
  "workspace:set_private",
  "workspace:whitelabel",
  "workspace:webhooks",
];
const BILLING: Policy[] = [
  "workspace:view_usage",
  "workspace:view_invoices",
  "workspace:update_payment",
  "upgrade:request",
];

export const ROLE_POLICIES: Record<WorkspaceRole, ReadonlySet<Policy>> = {
  observer: new Set([...READ]),
  external: new Set([...READ, ...CONTRIBUTE]),
  member: new Set([
    ...READ,
    ...CONTRIBUTE,
    "project:create",
    "conversation:delete",
    "report:publish",
    "workspace:view_usage",
  ]),
  billing: new Set(BILLING),
  admin: new Set([
    ...READ,
    ...CONTRIBUTE,
    ...MANAGE,
    ...BILLING,
    "project:create",
    "conversation:delete",
    "report:publish",
  ]),
  owner: new Set(POLICIES),
};

export const TIERS = ["free", "innovator", "changemaker", "guardian"] as const;
export type Tier = (typeof TIERS)[number];

/** Policies that also need the workspace's billing account on at least this tier. */
export const TIER_REQUIRED: Partial<Record<Policy, Tier>> = {
  "project:share": "innovator",
  "project:set_private": "innovator",
  "workspace:export": "innovator",
  "workspace:set_private": "innovator",
  "workspace:whitelabel": "changemaker",
  "workspace:webhooks": "changemaker",
};

export function meetsTier(tier: string | null, required: Tier): boolean {
  // A legacy project has no workspace and no tier; it has never been tier-gated.
  if (tier === null) return true;
  const have = TIERS.indexOf(tier as Tier);
  return have >= 0 && have >= TIERS.indexOf(required);
}

/**
 * Extra policies stored on a membership. Only known policies count; "*" and unknown
 * strings are ignored so a stray value can never widen access.
 */
export function customPolicies(raw: unknown): Policy[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (p): p is Policy => typeof p === "string" && (POLICIES as readonly string[]).includes(p),
  );
}

export function roleHas(
  role: WorkspaceRole,
  policy: Policy,
  extra: readonly Policy[] = [],
): boolean {
  return ROLE_POLICIES[role].has(policy) || extra.includes(policy);
}

export function isWorkspaceRole(v: unknown): v is WorkspaceRole {
  return (WORKSPACE_ROLES as readonly unknown[]).includes(v);
}

/** Stored `viewer` is a legacy name for member. */
export function normaliseRole(raw: string): WorkspaceRole | null {
  if (raw === "viewer") return "member";
  return isWorkspaceRole(raw) ? raw : null;
}

/**
 * What a staff support session may do (CTO decision 8.4). A session the customer opened
 * with the standing toggle is read-only; one they approved through a request may also
 * act as an admin, but never on consent, members or deletion.
 */
export const SUPPORT_READ_ONLY: ReadonlySet<Policy> = new Set([
  "project:read",
  "conversation:read",
  "report:view",
  "workspace:view_usage",
]);

export const SUPPORT_APPROVED: ReadonlySet<Policy> = new Set(
  [...ROLE_POLICIES.admin].filter(
    (p) =>
      ![
        "member:invite",
        "member:manage",
        "settings:manage",
        "project:delete",
        "report:delete",
        "conversation:delete",
      ].includes(p),
  ),
);
