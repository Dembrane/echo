import { t } from "@lingui/core/macro";

/**
 * Workspace + organisation role display rules (matrix v1.1 §5).
 *
 * Matrix collapses "owner" and "admin" into a single visible role
 * ("Admin") so the UI reads as one group of privileged people rather
 * than a two-tier hierarchy. The backend keeps "owner" as a distinct
 * value for:
 *   - last-admin protection (can't demote the last owner)
 *   - ownership transfer mechanics
 * …but the user never sees the word "Owner" in the product.
 *
 * Other role values ("member", "billing") pass through with a simple
 * capitalization.
 */
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
		case "guest":
		case "external":
			return t`Guest`;
		default:
			// Unknown role — fall back to capitalized raw value so new
			// roles added later don't silently render as an empty string.
			return role.charAt(0).toUpperCase() + role.slice(1);
	}
}

/**
 * Color for Mantine Badge rendering of a role. Keeps the organisation/workspace
 * admin cohort visually distinct from rank-and-file members.
 */
export function roleColor(role: string | null | undefined): string {
	if (role === "owner" || role === "admin") return "blue";
	if (role === "billing") return "yellow";
	return "gray";
}

/**
 * Returns true when this role belongs to the admin cohort (owner or
 * admin). Use for capability checks in the UI that mirror the
 * backend's admin-or-owner logic without hardcoding both values at
 * every call site.
 */
export function isAdminRole(role: string | null | undefined): boolean {
	return role === "owner" || role === "admin";
}
