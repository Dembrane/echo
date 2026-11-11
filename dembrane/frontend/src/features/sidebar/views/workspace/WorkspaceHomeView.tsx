import { Trans } from "@lingui/react/macro";
import { Badge } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { AppWindow, Gear, Plus, PushPin, Users } from "@phosphor-icons/react";
import { useMemo } from "react";
import { useParams } from "react-router";
import { UpgradeModal } from "@/components/workspace/FeatureGate";
import { wallPopoverLine } from "@/components/workspace/gateWalls";
import { UnavailableInfo } from "@/components/workspace/UnavailableInfo";
import { useProjectCap } from "@/hooks/useProjectCap";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useWorkspaceProjects } from "@/hooks/useWorkspaceProjects";
import { isAdminRole, isOutsiderRole } from "@/lib/roles";
import { BackButton } from "../../primitives/BackButton";
import { NavItem } from "../../primitives/NavItem";
import { SectionLabel } from "../../primitives/SectionLabel";
import { FullOnly } from "../../shell/rail";

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
	const atProjectCap = useProjectCap(workspace);
	const [capWallOpened, capWall] = useDisclosure(false);

	if (!workspaceId) return null;

	const base = `/w/${workspaceId}`;
	const backTo = workspace?.org_id ? `/o/${workspace.org_id}/overview` : "/";
	const backLabel = workspace?.org_name ?? "Home";
	// Outsiders (external + free read-only observer) can't create projects.
	const canCreateProject = !isOutsiderRole(workspace?.role);
	const isAdmin = isAdminRole(workspace?.role);
	const settingsPath = isAdmin
		? `${base}/settings/general`
		: `${base}/settings/billing`;

	return (
		<nav className="flex h-full flex-col gap-0.5 p-1.5">
			{/* Back button doubles as the section title: centered label is the
			    current context (the workspace), not the destination. */}
			<BackButton to={backTo} label={workspace?.name ?? backLabel} center />

			{workspace?.is_data_owner && (
				<FullOnly>
					<Badge
						color="primary"
						variant="light"
						radius="sm"
						className="mx-auto my-1"
						data-testid="data-owner-badge"
					>
						<Trans>You are the data owner</Trans>
					</Badge>
				</FullOnly>
			)}

			<NavItem
				to={`${base}/home`}
				label={<Trans>Overview</Trans>}
				icon={AppWindow}
			/>
			{canCreateProject && (
				<NavItem
					to={`${base}/projects/new`}
					label={
						atProjectCap ? (
							<span className="inline-flex items-center gap-1">
								<Trans>Create project</Trans>
								<UnavailableInfo label={wallPopoverLine("project_cap")} />
							</span>
						) : (
							<Trans>Create project</Trans>
						)
					}
					icon={Plus}
					muted={atProjectCap}
					onClick={
						atProjectCap
							? (event) => {
									event.preventDefault();
									capWall.open();
								}
							: undefined
					}
				/>
			)}
			{/* Settings is the last clickable item under the workspace title,
			    directly below Create project and above the Pinned projects section. */}
			{!isOutsiderRole(workspace?.role) && (
				<>
					<NavItem
						to={`${base}/members`}
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
				<FullOnly>
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
				</FullOnly>
			)}
			<UpgradeModal
				opened={capWallOpened}
				onClose={capWall.close}
				currentTier="free"
				requiredTier="changemaker"
				canRequestUpgrade={isAdmin}
				workspaceId={workspaceId}
				wallKey="project_cap"
			/>
		</nav>
	);
};
