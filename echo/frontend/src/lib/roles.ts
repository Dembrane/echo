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
	external: 0,
	member: 1,
	billing: 2,
	admin: 3,
	owner: 4,
};

/** Convenience: caller's level given their role string. Unknown → 0. */
export function roleLevel(role: string | null | undefined): number {
	if (!role) return 0;
	return ROLE_HIERARCHY[role] ?? 0;
}
