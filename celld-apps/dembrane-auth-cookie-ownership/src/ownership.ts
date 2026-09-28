import { type DirectusClaims, isAdmin } from "./auth";

// A user's role in an organisation (org_membership.role), or null if they
// aren't in it. dembrane also has "admin" and "billing"; this demo only seeds
// and distinguishes these two.
export type OrgRole = "owner" | "member";

// Who may do what with an organisation's projects. A cut-down version of
// dembrane's rules in echo/server/dembrane/policies.py, where an organisation
// owner's preset is ["*"]:
//
// - Anyone in the organisation can see its projects.
// - Only its owner can increment them.
// - Platform admins (admin_access) can do both, in every organisation.
export const canSeeProjects = (claims: DirectusClaims, role: OrgRole | null) => isAdmin(claims) || role !== null;

export const canIncrementProjects = (claims: DirectusClaims, role: OrgRole | null) =>
  isAdmin(claims) || role === "owner";
