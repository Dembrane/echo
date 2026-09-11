const PORTAL_SESSION_CONFIG_PARAMS = [
	"mode",
	"skipOnboarding",
	"tag_id_list",
	"tags",
	"theme",
] as const;

/**
 * Build a fresh portal start link while carrying forward only reusable portal
 * configuration. Participant details and in-progress content intentionally stay
 * with the current conversation.
 */
export const buildPortalSessionSharingLink = (
	baseLink: string,
	currentSearchParams: URLSearchParams,
) => {
	const url = new URL(baseLink);

	for (const param of PORTAL_SESSION_CONFIG_PARAMS) {
		const values = currentSearchParams.getAll(param);
		if (values.length === 0) continue;

		url.searchParams.delete(param);
		for (const value of values) {
			url.searchParams.append(param, value);
		}
	}

	return url.toString();
};
