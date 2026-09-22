import { Trans } from "@lingui/react/macro";
import {
	AppWindowIcon,
	BooksIcon,
	BroadcastIcon,
	ChatCircleDotsIcon,
	ChatCircleTextIcon,
	FileTextIcon,
	GearIcon,
	GraphIcon,
	PaintBrushIcon,
	PlayIcon,
	PopcornIcon,
	RobotIcon,
	SparkleIcon,
} from "@phosphor-icons/react";
import { useLocation, useParams } from "react-router";
import { useProjectChatsCountQuery } from "@/components/chat/hooks";
import { useConversationsCountByProjectId } from "@/components/conversation/hooks";
import { useProjectById } from "@/components/project/hooks";
import {
	ENABLE_CANVAS,
	ENABLE_MONITOR,
	ENABLE_PRESENT,
	ENABLE_WEBHOOKS,
} from "@/config";
import { useWorkspace } from "@/hooks/useWorkspace";
import { isReadOnlyRole } from "@/lib/roles";
import { BackButton } from "../../primitives/BackButton";
import { NavItem } from "../../primitives/NavItem";

export const ProjectHomeView = () => {
	const { workspaceId, projectId } = useParams<{
		workspaceId: string;
		projectId: string;
	}>();
	const { pathname } = useLocation();
	const { workspace } = useWorkspace();
	// Observers are read-only and have no chat access. Hide the Ask tab and skip
	// its count query (it 403s for them); passing "" disables the query.
	const isObserver = isReadOnlyRole(workspace?.role);
	// Fetch by id so the project name renders even when the workspace
	// context hasn't yet synced from the URL (saves a one-tick flash).
	const projectQuery = useProjectById({
		projectId: projectId ?? "",
		query: { fields: ["id", "name", "is_canvas_enabled"] },
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
	const popcornActive = pathname.includes(
		`/projects/${projectId}/library/popcorn`,
	);
	const libraryActive =
		!popcornActive &&
		(pathname.includes(`/projects/${projectId}/library`) ||
			pathname.includes(`/projects/${projectId}/canvases/`));
	const isWorkspaceAdmin =
		workspace?.role === "admin" || workspace?.role === "owner";

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
				to={`${base}/conversations`}
				label={<Trans>Conversations</Trans>}
				icon={ChatCircleTextIcon}
				badge={conversationsCountQuery.data || undefined}
			/>
			<div className="mt-2 flex flex-col gap-0.5">
				<NavItem
					to={`${base}/portal-editor`}
					label={<Trans>Portal editor</Trans>}
					icon={PaintBrushIcon}
				/>
				{ENABLE_MONITOR && (
					<NavItem
						to={`${base}/monitor`}
						label={<Trans>Monitor</Trans>}
						icon={BroadcastIcon}
						badge={<Trans>Beta</Trans>}
					/>
				)}
				{ENABLE_PRESENT && (
					<NavItem
						to={`${base}/present`}
						label={<Trans>Present</Trans>}
						icon={PlayIcon}
					/>
				)}
			</div>
			{/* Library is the canvas surface: the env flag mounts the routes,
			    but each project also opts in via the experimental toggle in
			    project settings (is_canvas_enabled). */}
			{!ENABLE_PRESENT && ENABLE_CANVAS && project?.is_canvas_enabled && (
				<NavItem
					to={`${base}/library`}
					label={<Trans>Library</Trans>}
					icon={BooksIcon}
					active={libraryActive}
				/>
			)}
			{/* Popcorn lives in the Library but earns a shortcut. Before the
			    project opts in, the page itself explains and offers to turn it on. */}
			{!ENABLE_PRESENT && ENABLE_CANVAS && (
				<NavItem
					to={`${base}/library/popcorn`}
					label={<Trans>Popcorn</Trans>}
					icon={PopcornIcon}
					badge={<Trans>Beta</Trans>}
					active={popcornActive}
				/>
			)}
			<div className="mt-2 flex flex-col gap-0.5">
				{ENABLE_PRESENT && (
					<NavItem
						to={`${base}/analysis`}
						label={<Trans>Analysis</Trans>}
						icon={SparkleIcon}
					/>
				)}
				<NavItem
					to={`${base}/report`}
					label={<Trans>Report</Trans>}
					icon={FileTextIcon}
				/>
				{!ENABLE_PRESENT && (
					<NavItem
						to={`${base}/map`}
						label={<Trans>Map</Trans>}
						icon={GraphIcon}
						badge={<Trans>Beta</Trans>}
					/>
				)}
				{ENABLE_WEBHOOKS && isWorkspaceAdmin && (
					<NavItem
						to={`${base}/integrations`}
						label={<Trans>Automation</Trans>}
						icon={RobotIcon}
					/>
				)}
			</div>
			<NavItem
				to={`${base}/overview`}
				label={<Trans>Manage</Trans>}
				icon={GearIcon}
				pushes
			/>
		</nav>
	);
};
