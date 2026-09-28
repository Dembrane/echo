// Validates ?next= deep-links: a stale next can point at an org/workspace
// the freshly logged-in account can't access.
import { isAuthPath } from "./authPaths";

// Same-origin path guard against open-redirect via ?next=//evil.com.
export const isSafeNextPath = (
	next: string | null | undefined,
): next is string => {
	if (!next) return false;
	if (!next.startsWith("/")) return false;
	if (next.startsWith("//") || next.startsWith("/\\")) return false;
	return true;
};

const UUID_RE =
	/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Locale-prefix-tolerant path segments, query/hash stripped.
const pathSegments = (path: string): string[] => {
	const segments = path.split(/[?#]/)[0].split("/").filter(Boolean);
	if (segments[0] && /^[a-z]{2}(-[A-Z]{2})?$/.test(segments[0])) {
		segments.shift();
	}
	return segments;
};

const scopedId = (path: string, prefix: "w" | "o"): string | null => {
	const segments = pathSegments(path);
	if (segments[0] !== prefix || !segments[1]) return null;
	return UUID_RE.test(segments[1]) ? segments[1] : null;
};

// Returns the workspace UUID from /w/:id/... else null.
export const extractWorkspaceIdFromPath = (path: string): string | null =>
	scopedId(path, "w");

// Returns the organisation UUID from /o/:id/... else null.
export const extractOrgIdFromPath = (path: string): string | null =>
	scopedId(path, "o");

/** /o/:orgId/account, and /o/:orgId/account/documents/:docId/sign. */
export const isAccountPath = (path: string): boolean => {
	const s = pathSegments(path);
	if (s[0] !== "o" || !UUID_RE.test(s[1] ?? "") || s[2] !== "account") return false;
	if (s.length === 3) return true;
	return (
		s.length === 6 &&
		s[3] === "documents" &&
		UUID_RE.test(s[4] ?? "") &&
		s[5] === "sign"
	);
};

interface AccessibleWorkspace {
	id: string;
	org_id?: string;
}

// Returns `next` when it is a safe path the account may deep-link into
// (/w/:id needs membership, /o/:id needs a workspace in that org), else null.
export const resolveNextPath = (
	next: string | null | undefined,
	workspaces: AccessibleWorkspace[],
): string | null => {
	if (!isSafeNextPath(next)) return null;
	if (isAuthPath(next)) return null;

	const wsId = extractWorkspaceIdFromPath(next);
	if (wsId && !workspaces.some((w) => w.id === wsId)) return null;

	// The account page and a signing link are authorised by the accounts API itself: a
	// person named to sign is not a member of the organisation, and an org's billing
	// contact may have no workspace in it. The page shows its own "not shared with you".
	if (isAccountPath(next)) return next;

	const orgId = extractOrgIdFromPath(next);
	if (orgId && !workspaces.some((w) => w.org_id === orgId)) return null;

	return next;
};
