import { Navigate, useLocation, useParams } from "react-router";
import { BeautifulLoading } from "@/components/common/BeautifulLoading";
import { useV2Me } from "@/hooks/useV2Me";
import { lastWorkspaceKey, useWorkspace } from "@/hooks/useWorkspace";

const readLastWorkspaceId = (userId: string | null): string | null => {
	if (!userId) return null;
	try {
		return localStorage.getItem(lastWorkspaceKey(userId));
	} catch {
		return null;
	}
};

/**
 * Static entry point for creating a project (/projects/new), so a link in an
 * email or on a website needs no workspace id. Opens the wizard in the last-used
 * workspace, else the default or first one; people without a workspace go to
 * onboarding.
 */
export const NewProjectRedirect = () => {
	const { language } = useParams();
	const { search, hash } = useLocation();
	const prefix = language ? `/${language}` : "";

	const { data: me, isLoading: meLoading } = useV2Me();
	const { workspaces, isLoading: workspacesLoading, isError } = useWorkspace();

	if (meLoading || workspacesLoading) return <BeautifulLoading />;

	// A failed workspace request says nothing about the person's workspaces.
	if (isError) return <Navigate to={`${prefix}/`} replace />;

	const lastId = readLastWorkspaceId(me?.directus_user_id ?? null);
	// Stored ids can outlive access to the workspace.
	const target =
		workspaces.find((w) => w.id === lastId) ??
		workspaces.find((w) => w.is_default) ??
		workspaces[0];

	if (!target) return <Navigate to={`${prefix}/onboarding`} replace />;

	return (
		<Navigate
			to={`${prefix}/w/${target.id}/projects/new${search}${hash}`}
			replace
		/>
	);
};
