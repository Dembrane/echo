import { usePostHog } from "@posthog/react";
import { useEffect } from "react";
import { useV2Me } from "@/hooks/useV2Me";
import { identifyHost } from "./identity";

/**
 * Keeps the signed-in host identified in PostHog, whichever way they signed in (password,
 * emailed code, Google, a session restored from a cookie). Renders nothing. Mounted only
 * behind sign-in, so portal participants are never identified.
 */
export const HostIdentitySync = () => {
	const posthog = usePostHog();
	const { data: me } = useV2Me();
	const email = me?.email;
	const directusUserId = me?.directus_user_id;
	const isInvited = me?.is_invited;
	const orgId = me ? (me.orgs?.[0]?.id ?? null) : undefined;

	useEffect(() => {
		if (!email) return;
		identifyHost(posthog, { directusUserId, email, isInvited, orgId });
	}, [posthog, email, directusUserId, isInvited, orgId]);

	return null;
};
