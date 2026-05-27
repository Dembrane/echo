import { Trans } from "@lingui/react/macro";
import {
	AppWindow,
	BookOpen,
	Broadcast,
	ChatCircleDots,
	ChatCircleText,
	FileText,
	Gear,
	Graph,
	PaintBrush,
} from "@phosphor-icons/react";
import { useParams } from "react-router";
import { useConversationsCountByProjectId } from "@/components/conversation/hooks";
import { useProjectById } from "@/components/project/hooks";
import { useWorkspace } from "@/hooks/useWorkspace";
import { BackButton } from "../../primitives/BackButton";
import { NavButton } from "../../primitives/NavButton";
import { NavItem } from "../../primitives/NavItem";

export const ProjectHomeView = () => {
	const { workspaceId, projectId } = useParams<{
		workspaceId: string;
		projectId: string;
	}>();
	// Fetch by id so the project name renders even when the workspace
	// context hasn't yet synced from the URL (saves a one-tick flash).
	const projectQuery = useProjectById({
		projectId: projectId ?? "",
		query: { fields: ["id", "name"] },
	});
	const conversationsCountQuery = useConversationsCountByProjectId(
		projectId ?? "",
	);
	const project = projectQuery.data;
	const { workspaces } = useWorkspace();
	const workspace = workspaces.find((w) => w.id === workspaceId);

	if (!workspaceId || !projectId) return null;
	const base = `/w/${workspaceId}/projects/${projectId}`;

	return (
		<nav className="flex h-full flex-col gap-0.5 p-1.5">
			<BackButton
				to={`/w/${workspaceId}/home`}
				label={workspace?.name ?? <Trans>Workspace</Trans>}
			/>

			{project?.name && (
				<div
					className="px-2 pb-1 pt-2 text-[13px] leading-tight"
					style={{ color: "#2d2d2c" }}
				>
					<div className="truncate">{project.name}</div>
				</div>
			)}

			<NavItem to={`${base}/home`} label={<Trans>Overview</Trans>} icon={AppWindow} />
			<NavItem
				to={`${base}/chats/new`}
				label={<Trans>Ask</Trans>}
				icon={ChatCircleDots}
			/>
			<NavButton
				label={<Trans>Explore</Trans>}
				icon={Graph}
				onClick={() => undefined}
				badge={<Trans>Planned</Trans>}
				disabled
			/>
			<NavItem
				to={`${base}/portal-editor`}
				label={<Trans>Portal editor</Trans>}
				icon={PaintBrush}
			/>
			<NavButton
				label={<Trans>Monitor</Trans>}
				icon={Broadcast}
				onClick={() => undefined}
				badge={<Trans>Planned</Trans>}
				disabled
			/>
			<NavItem
				to={`${base}/host-guide`}
				label={<Trans>Host guide</Trans>}
				icon={BookOpen}
			/>
			<NavItem
				to={`${base}/report`}
				label={<Trans>Report</Trans>}
				icon={FileText}
			/>
			<NavItem
				to={`${base}/conversations`}
				label={<Trans>Conversations</Trans>}
				icon={ChatCircleText}
				badge={
					typeof conversationsCountQuery.data === "number"
						? conversationsCountQuery.data
						: undefined
				}
			/>

			<div className="mt-auto" />
			<NavItem
				to={`${base}/overview`}
				label={<Trans>Settings</Trans>}
				icon={Gear}
				pushes
			/>
		</nav>
	);
};
