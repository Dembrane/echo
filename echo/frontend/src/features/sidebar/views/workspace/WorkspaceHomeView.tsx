import { Trans } from "@lingui/react/macro";
import { AppWindow, Gear, Plus, PushPin, Users } from "@phosphor-icons/react";
import { useMemo } from "react";
import { useParams } from "react-router";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useWorkspaceProjects } from "@/hooks/useWorkspaceProjects";
import { isAdminRole } from "@/lib/roles";
import { BackButton } from "../../primitives/BackButton";
import { NavItem } from "../../primitives/NavItem";
import { SectionLabel } from "../../primitives/SectionLabel";

export const WorkspaceHomeView = () => {
	const { workspaceId } = useParams<{ workspaceId: string }>();
	const { workspaces } = useWorkspace();
	const projectsQuery = useWorkspaceProjects({ limit: 8 });

	const workspace = useMemo(
		() => workspaces.find((w) => w.id === workspaceId),
		[workspaces, workspaceId],
	);
	const pinnedProjects = useMemo(
		() => projectsQuery.data?.pages.flatMap((page) => page.pinned) ?? [],
		[projectsQuery.data],
	);

	if (!workspaceId) return null;

	const base = `/w/${workspaceId}`;
	const backTo = workspace?.org_id ? `/o/${workspace.org_id}/overview` : "/";
	const backLabel = workspace?.org_name ?? "Home";
	const isExternal = workspace?.role === "external";
	const canCreateProject = !isExternal;
		const isAdmin = isAdminRole(workspace?.role);
		const settingsPath = isAdmin
			? `${base}/settings/general`
			: `${base}/settings/billing`;

	return (
		<nav className="flex h-full flex-col gap-0.5 p-1.5">
			{/* Back button doubles as the section title: centered label is the
			    current context (the workspace), not the destination. */}
			<BackButton to={backTo} label={workspace?.name ?? backLabel} center />

			<NavItem
				to={`${base}/home`}
				label={<Trans>Overview</Trans>}
				icon={AppWindow}
			/>
			{canCreateProject && (
				<NavItem
					to={`${base}/projects/new`}
					label={<Trans>New project</Trans>}
					icon={Plus}
				/>
			)}
			{/* Settings is the last clickable item under the workspace title,
			    directly below New project and above the Pinned projects section. */}
				{!isExternal && (
					<>
						<NavItem
							to={`${base}/settings/members`}
							label={<Trans>Members</Trans>}
							icon={Users}
						/>
						<NavItem
							to={settingsPath}
							label={<Trans>Settings</Trans>}
							icon={Gear}
							pushes
						/>
					</>
				)}
			{pinnedProjects.length > 0 && (
				<>
					<SectionLabel>
						<Trans>Pinned projects</Trans>
					</SectionLabel>
					{pinnedProjects.map((project) => (
						<NavItem
							key={project.id}
							to={`${base}/projects/${project.id}/home`}
							label={project.name || <Trans>Untitled</Trans>}
							icon={PushPin}
							pushes
						/>
					))}
				</>
			)}
		</nav>
	);
};
