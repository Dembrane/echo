import { Trans } from "@lingui/react/macro";
import {
	AppWindowIcon,
	BookOpenIcon,
	BroadcastIcon,
	ChartLineIcon,
	ChatCircleDotsIcon,
	ChatCircleTextIcon,
	FileTextIcon,
	GearIcon,
	GraphIcon,
	PaintBrushIcon,
	UsersThreeIcon,
} from "@phosphor-icons/react";
import { useParams } from "react-router";
import { useProjectChatsCountQuery } from "@/components/chat/hooks";
import { useConversationsCountByProjectId } from "@/components/conversation/hooks";
import { useProjectById } from "@/components/project/hooks";
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
	const chatsCountQuery = useProjectChatsCountQuery(projectId ?? "", {
		hasMessages: true,
	});
	const project = projectQuery.data;

	if (!workspaceId || !projectId) return null;
	const base = `/w/${workspaceId}/projects/${projectId}`;

	return (
		<nav className="flex h-full flex-col gap-0.5 p-1.5">
			{/* Back button doubles as the section title: centered label is the
			    current context (the project), not the destination. */}
			<BackButton
				to={`/w/${workspaceId}/home`}
				label={project?.name ?? <Trans>Project</Trans>}
				center
			/>

			<NavItem
				to={`${base}/home`}
				label={<Trans>Overview</Trans>}
				icon={AppWindowIcon}
			/>
			<NavItem
				to={`${base}/chats/new`}
				label={<Trans>Ask</Trans>}
				icon={ChatCircleDotsIcon}
				badge={chatsCountQuery.data || undefined}
			/>
			<NavButton
				label={<Trans>Explore</Trans>}
				icon={GraphIcon}
				onClick={() => undefined}
				badge={<Trans>Planned</Trans>}
				disabled
			/>
			<NavItem
				to={`${base}/portal-editor`}
				label={<Trans>Portal editor</Trans>}
				icon={PaintBrushIcon}
			/>
			<NavButton
				label={<Trans>Monitor</Trans>}
				icon={BroadcastIcon}
				onClick={() => undefined}
				badge={<Trans>Planned</Trans>}
				disabled
			/>
			<NavItem
				to={`${base}/host-guide`}
				label={<Trans>Host guide</Trans>}
				icon={BookOpenIcon}
			/>
			<NavItem
				to={`${base}/report`}
				label={<Trans>Report</Trans>}
				icon={FileTextIcon}
			/>
			<NavItem
				to={`${base}/conversations`}
				label={<Trans>Conversations</Trans>}
				icon={ChatCircleTextIcon}
				badge={conversationsCountQuery.data || undefined}
			/>
			<NavItem
				to={`${base}/access`}
				label={<Trans>Access</Trans>}
				icon={UsersThreeIcon}
			/>
			<NavItem
				to={`${base}/usage`}
				label={<Trans>Usage</Trans>}
				icon={ChartLineIcon}
			/>
			{/* Settings is the last clickable item, directly after the rest of
				    the project items. */}
			<NavItem
				to={`${base}/overview`}
				label={<Trans>Settings</Trans>}
				icon={GearIcon}
				pushes
			/>
		</nav>
	);
};
