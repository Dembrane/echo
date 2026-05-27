import { Trans } from "@lingui/react/macro";
import { Gear, House, Plus, PushPin } from "@phosphor-icons/react";
import { useMemo } from "react";
import { useParams } from "react-router";
import { isAdminRole } from "@/lib/roles";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useWorkspaceProjects } from "@/hooks/useWorkspaceProjects";
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
	const isBilling = workspace?.role === "billing";
	const settingsPath = isAdmin
		? `${base}/settings/general`
		: isBilling
			? `${base}/settings/billing`
			: `${base}/settings/members`;

	return (
		<nav className="flex h-full flex-col gap-0.5 p-1.5">
			<BackButton to={backTo} label={backLabel} />

			{workspace?.name && (
				<div
					className="px-2 pb-1 pt-2 text-[13px] leading-tight"
					style={{ color: "#2d2d2c" }}
				>
					<div className="truncate">{workspace.name}</div>
				</div>
			)}

			<NavItem to={`${base}/home`} label={<Trans>Home</Trans>} icon={House} />
			{canCreateProject && (
				<NavItem
					to={`${base}/projects/new`}
					label={<Trans>New project</Trans>}
					icon={Plus}
				/>
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
			{!isExternal && (
				<>
					<div className="mt-auto" />
					<NavItem
						to={`${base}/settings/general`}
						label={<Trans>Settings</Trans>}
						icon={Gear}
						pushes
					/>
				</>
			)}
		</nav>
	);
};
