/**
 * Where onboarding ends. A self-serve host who set up their own organisation just now, and
 * has no project of their own, goes straight to the template picker in the workspace
 * onboarding made for them (ECHO-1042: most self-serve sign-ups never reached "Create
 * project" from the organisation overview). Everyone else lands on /o as before: invited
 * people join someone else's work, a host with projects from before workspaces has some,
 * and a returning host never passes the organisation step.
 */
export function postOnboardingPath(p: {
	/** The workspace onboarding created in this visit; null when the org step did not run. */
	createdWorkspaceId: string | null;
	/** Pending invites when the flow started. */
	startedWithInvites: boolean;
	/** /v2/me is_invited: an invite to the email existed before the account. */
	isInvited: boolean;
	/** /v2/me has_legacy_projects. */
	hasLegacyProjects: boolean;
}): string {
	const selfServe = !p.startedWithInvites && !p.isInvited;
	if (selfServe && p.createdWorkspaceId && !p.hasLegacyProjects)
		return `/w/${p.createdWorkspaceId}/projects/new`;
	return "/o";
}
