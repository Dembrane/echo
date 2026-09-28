import { t } from "@lingui/core/macro";

// "owner" and "admin" both display as "Admin"; backend keeps "owner" distinct for last-admin / transfer mechanics.
export function displayRole(role: string | null | undefined): string {
	if (!role) return "";
	switch (role) {
		case "owner":
		case "admin":
			return t`Admin`;
		case "member":
			return t`Member`;
		case "billing":
			return t`Billing`;
		case "external":
			return t`External`;
		case "observer":
			return t`Observer`;
		default:
			return role.charAt(0).toUpperCase() + role.slice(1);  // capitalize unknown roles instead of returning ""
	}
}

export function roleColor(role: string | null | undefined): string {
	if (role === "owner" || role === "admin") return "blue";
	if (role === "billing") return "yellow";
	return "gray";
}

export function isAdminRole(role: string | null | undefined): boolean {
	return role === "owner" || role === "admin";
}

// Mirrors backend `dembrane.policies.ROLE_HIERARCHY`. Always compare levels, not strings (`role === "admin"` silently misses "owner").
export const ROLE_HIERARCHY: Record<string, number> = {
	observer: 0,
	external: 1,
	member: 2,
	billing: 3,
	admin: 4,
	owner: 5,
};

/** Convenience: caller's level given their role string. Unknown → 0. */
export function roleLevel(role: string | null | undefined): number {
	if (!role) return 0;
	return ROLE_HIERARCHY[role] ?? 0;
}

// Outside collaborator roles (no org_membership). `external` is paid;
// `observer` is the free, read-only role (Wave G). Mirrors backend.
export function isOutsiderRole(role: string | null | undefined): boolean {
	return role === "external" || role === "observer";
}

// Read-only roles that cannot chat / generate / edit. Today: observer.
// (external keeps chat:use + report:generate, so it is NOT read-only.)
export function isReadOnlyRole(role: string | null | undefined): boolean {
	return role === "observer";
}

/** Whether a workspace role may use chat. Observers cannot (upgrade wall). */
export function canUseChat(role: string | null | undefined): boolean {
	return role !== "observer";
}
