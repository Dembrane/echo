import { isAdminRole, isOutsiderRole } from "@/lib/roles";
import type { WorkspaceChoice } from "./WhichWorkspaceModal";

/**
 * What a person may create from the Create menu. A project needs a workspace where they
 * are not an outsider and no block on creating projects, as workspace home decides; a
 * workspace needs an organisation they own or administer, as the workspace wizard does.
 * Organisation is always offered: its own dialog holds the free plan's wall.
 */
export const createAccess = ({
	workspaces,
	orgs,
	projectsBlocked,
}: {
	workspaces: readonly {
		id: string;
		name: string;
		org_name: string;
		role: string;
	}[];
	orgs: readonly { role: string }[];
	/** The user's `disable_create_project`. */
	projectsBlocked: boolean;
}): { projectWorkspaces: WorkspaceChoice[]; canCreateWorkspace: boolean } => ({
	canCreateWorkspace: orgs.some((o) => isAdminRole(o.role)),
	projectWorkspaces: projectsBlocked
		? []
		: workspaces
				.filter((w) => !isOutsiderRole(w.role))
				.map((w) => ({ id: w.id, name: w.name, orgName: w.org_name })),
});
