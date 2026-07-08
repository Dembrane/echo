import { Trans } from "@lingui/react/macro";
import {
	AppWindowIcon,
	BookOpenIcon,
	BooksIcon,
	BroadcastIcon,
	ChartLineIcon,
	ChatCircleDotsIcon,
	ChatCircleTextIcon,
	FileTextIcon,
	GearIcon,
	PaintBrushIcon,
	UsersThreeIcon,
} from "@phosphor-icons/react";
import { useParams } from "react-router";
import { useProjectChatsCountQuery } from "@/components/chat/hooks";
import { useConversationsCountByProjectId } from "@/components/conversation/hooks";
import { useProjectById } from "@/components/project/hooks";
import { useWorkspace } from "@/hooks/useWorkspace";
import { isReadOnlyRole } from "@/lib/roles";
import { BackButton } from "../../primitives/BackButton";
import { NavItem } from "../../primitives/NavItem";

export const ProjectHomeView = () => {
	const { workspaceId, projectId } = useParams<{
		workspaceId: string;
		projectId: string;
	}>();
	const { workspace } = useWorkspace();
	// Observers are read-only and have no chat access. Hide the Ask tab and skip
	// its count query (it 403s for them); passing "" disables the query.
	const isObserver = isReadOnlyRole(workspace?.role);
	// Fetch by id so the project name renders even when the workspace
	// context hasn't yet synced from the URL (saves a one-tick flash).
	const projectQuery = useProjectById({
		projectId: projectId ?? "",
		query: { fields: ["id", "name"] },
	});
	const conversationsCountQuery = useConversationsCountByProjectId(
		projectId ?? "",
	);
	const chatsCountQuery = useProjectChatsCountQuery(
		isObserver ? "" : (projectId ?? ""),
		{ hasMessages: true },
	);
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
			{!isObserver && (
				<NavItem
					to={`${base}/chats/new`}
					label={<Trans>Ask</Trans>}
					icon={ChatCircleDotsIcon}
					badge={chatsCountQuery.data || undefined}
				/>
			)}
			<NavItem
				to={`${base}/portal-editor`}
				label={<Trans>Portal editor</Trans>}
				icon={PaintBrushIcon}
			/>
			<NavItem
				to={`${base}/monitor`}
				label={<Trans>Monitor</Trans>}
				icon={BroadcastIcon}
			/>
			<NavItem
				to={`${base}/library`}
				label={<Trans>Library</Trans>}
				icon={BooksIcon}
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
