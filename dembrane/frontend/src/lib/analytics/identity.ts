import type { PostHog } from "posthog-js";

/**
 * One PostHog person per host, on the browser and the server.
 *
 * A host's distinct id is their email, lowercased. That is what the browser has always
 * identified with and what the server already sends for chats and sign-ins, so the
 * history of existing hosts stays where it is and no identified person is ever merged
 * into another (PostHog refuses that). Server events that only know the Directus user
 * id are joined to the same person with one alias: that id is never identified, so
 * PostHog accepts it as an alias.
 *
 * Only the dashboard calls this. Portal participants are never identified.
 */

export type IdentityClient = Pick<
	PostHog,
	"get_distinct_id" | "identify" | "alias" | "setPersonProperties"
> & { __loaded?: boolean };

export interface HostIdentity {
	email: string | null | undefined;
	directusUserId?: string | null;
	isInvited?: boolean | null;
	orgId?: string | null;
}

export interface KeyValueStore {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

/** The distinct id a host is known by: their email, trimmed and lowercased. */
export function hostDistinctId(
	email: string | null | undefined,
): string | null {
	const id = email?.trim().toLowerCase();
	return id ? id : null;
}

const ALIAS_KEY = "dembrane.analytics.aliased";

function browserStore(): KeyValueStore | null {
	try {
		return typeof window === "undefined" ? null : window.localStorage;
	} catch {
		return null;
	}
}

/**
 * Identifies the signed-in host and sets `email`, `is_invited` and `org_id` on their
 * person. Safe to call on every page load: nothing is sent twice that changes anything.
 */
export function identifyHost(
	ph: IdentityClient | null | undefined,
	host: HostIdentity,
	store: KeyValueStore | null = browserStore(),
): void {
	// Not initialised (analytics off, or a test double): nothing to do.
	if (!ph?.__loaded) return;
	const id = hostDistinctId(host.email);
	if (!id) return;

	const props: Record<string, unknown> = { email: id };
	if (typeof host.isInvited === "boolean") props.is_invited = host.isInvited;
	if (host.orgId !== undefined) props.org_id = host.orgId ?? null;

	const current = ph.get_distinct_id();
	if (current === id) {
		ph.setPersonProperties(props);
	} else if (current && current.toLowerCase() === id) {
		// Identified before with the email as typed ("Ana@x.nl"). Keep that person and
		// give it the lowercased id the server uses, instead of starting a new one.
		ph.alias(id, current);
		ph.setPersonProperties(props);
	} else {
		ph.identify(id, props);
	}

	aliasOnce(ph, host.directusUserId, id, store);
}

/** Links the Directus user id the server sends some events under, once per browser. */
function aliasOnce(
	ph: IdentityClient,
	directusUserId: string | null | undefined,
	id: string,
	store: KeyValueStore | null,
): void {
	if (!directusUserId || directusUserId === id) return;
	const key = `${ALIAS_KEY}.${directusUserId}`;
	try {
		if (store?.getItem(key) === id) return;
	} catch {
		// Storage blocked: alias again, PostHog ignores an alias it already has.
	}
	ph.alias(directusUserId, ph.get_distinct_id());
	try {
		store?.setItem(key, id);
	} catch {}
}
