import { useEffect } from "react";
import { useAuthenticated, useCurrentUser } from "@/components/auth/hooks";
import { DIRECTUS_PUBLIC_URL } from "@/config";
import { useV2Me } from "@/hooks/useV2Me";
import { useWhitelabelLogo } from "@/hooks/useWhitelabelLogo";
import { useWorkspace } from "@/hooks/useWorkspace";
import { logoUrl as resolveLogoUrl } from "@/lib/avatar";
import { useSidebarView } from "../hooks/useSidebarView";

// Mirrors the resolver effect that used to live in Header.tsx. Picks
// the workspace's logo when inside a workspace scope, falls back to the
// user's whitelabel logo, otherwise clears.
export function useSidebarWhitelabelLogo(): void {
	const { isAuthenticated } = useAuthenticated();
	const { data: user } = useCurrentUser({ enabled: isAuthenticated });
	// touch so v2 me cache stays warm — same as old Header
	useV2Me({ enabled: isAuthenticated });
	const { workspace, isLoading: workspaceLoading } = useWorkspace();
	const { scope } = useSidebarView();
	const { setLogoUrl } = useWhitelabelLogo();

	const insideWorkspace = scope === "workspace" || scope === "project";

	useEffect(() => {
		if (!isAuthenticated) {
			setLogoUrl(null);
			return;
		}
		if (insideWorkspace && workspaceLoading) return;

		const workspaceLogo = insideWorkspace
			? (resolveLogoUrl(workspace?.logo_url) ??
				resolveLogoUrl(workspace?.org_logo_url))
			: undefined;
		const resolved =
			workspaceLogo ??
			(user?.whitelabel_logo
				? `${DIRECTUS_PUBLIC_URL}/assets/${user.whitelabel_logo}`
				: null);
		setLogoUrl(resolved ?? null);
	}, [
		isAuthenticated,
		insideWorkspace,
		workspaceLoading,
		workspace?.logo_url,
		workspace?.org_logo_url,
		user?.whitelabel_logo,
		setLogoUrl,
	]);
}
