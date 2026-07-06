import { CaretRightIcon } from "@phosphor-icons/react";
import { useMemo } from "react";
import { useParams } from "react-router";
import { useChat } from "@/components/chat/hooks";
import { I18nLink } from "@/components/common/i18nLink";
import { useConversationById } from "@/components/conversation/hooks";
import { useProjectById } from "@/components/project/hooks";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useSidebarState } from "../hooks/useSidebarState";
import { useSidebarView } from "../hooks/useSidebarView";

interface Crumb {
	label: string;
	href?: string;
}

const MAX_CRUMB_LABEL_LENGTH = 30;

const truncateMiddle = (text: string, maxLength = MAX_CRUMB_LABEL_LENGTH) => {
	if (text.length <= maxLength) return text;
	const ellipsis = "...";
	const visible = maxLength - ellipsis.length;
	const head = Math.ceil(visible / 2);
	const tail = Math.floor(visible / 2);
	return `${text.slice(0, head)}${ellipsis}${text.slice(text.length - tail)}`;
};

const ADMIN_TAB_LABELS: Record<string, string> = {
	partners: "Partners",
	upgrades: "Upgrades",
	"usage-and-billing": "Usage and billing",
};

const WORKSPACE_SETTINGS_LABELS: Record<string, string> = {
	billing: "Billing",
	danger: "Danger zone",
	general: "General",
	members: "Members",
};

const PROJECT_SECTION_LABELS: Record<string, string> = {
	access: "Access",
	chats: "Ask",
	conversation: "Conversation",
	conversations: "Conversations",
	export: "Export",
	home: "Overview",
	"host-guide": "Host guide",
	integrations: "Integrations",
	library: "Explore",
	monitor: "Monitor",
	overview: "Settings",
	portal: "Portal editor",
	"portal-editor": "Portal editor",
	report: "Report",
	upload: "Upload",
	usage: "Usage",
};

const USER_SETTINGS_LABELS: Record<string, string> = {
	access: "My access",
	account: "Account & security",
	appearance: "Appearance",
	assistant: "Assistant",
	"project-defaults": "Project defaults",
};

const ORG_SECTION_LABELS: Record<string, string> = {
	billing: "Billing",
	members: "Members",
	overview: "Overview",
	people: "Members",
	"request-workspace": "Request workspace",
	usage: "Usage",
};

const ORG_SETTINGS_LABELS: Record<string, string> = {
	billing: "Billing",
	general: "General",
	members: "Members",
	usage: "Usage and tier",
};

// Render when there is at least 1 meaningful crumb to show.
export const AppBreadcrumbs = () => {
	const { view, params } = useSidebarView();
	const { collapsed } = useSidebarState();
	const { orgId: routeOrgId, organisationId } = useParams<{
		orgId?: string;
		organisationId?: string;
	}>();
	const orgId = routeOrgId ?? organisationId;
	const { workspaces } = useWorkspace();
	const projectQuery = useProjectById({
		projectId: params.projectId ?? "",
		query: { fields: ["id", "name"] },
	});
	// Same default args as the detail page, so this reads its cached entry
	// instead of issuing a second request.
	const conversationQuery = useConversationById({
		conversationId: params.conversationId ?? "",
		useQueryOpts: { enabled: !!params.conversationId },
	});
	const chatQuery = useChat(params.chatId ?? "");

	const workspace = useMemo(
		() => workspaces.find((w) => w.id === params.workspaceId),
		[workspaces, params.workspaceId],
	);
	const orgNameForId = useMemo(() => {
		const id = orgId ?? params.orgId;
		return workspaces.find((w) => w.org_id === id)?.org_name ?? null;
	}, [workspaces, orgId, params.orgId]);

	const crumbs: Crumb[] = useMemo(() => {
		// Always start with Home so the trail is anchored to a real
		// clickable parent.
		const out: Crumb[] = [{ href: "/o", label: "Home" }];
		// Emit the org crumb before the workspace one, so workspace/project
		// trails read Home › Org › Workspace › Project.
		const pushWorkspaceCrumbs = (ws: NonNullable<typeof workspace>) => {
			if (ws.org_id) {
				out.push({ href: `/o/${ws.org_id}/overview`, label: ws.org_name });
			}
			out.push({ href: `/w/${ws.id}/home`, label: ws.name });
		};
		switch (view) {
			case "inbox":
			case "help":
				return out;
			case "user-home":
				return out;
			case "user-settings": {
				out.push({ href: "/settings/account", label: "User settings" });
				const section = params.section;
				if (section && USER_SETTINGS_LABELS[section]) {
					out.push({ label: USER_SETTINGS_LABELS[section] });
				}
				return out;
			}
			case "admin-home": {
				out.push({
					href: "/admin/usage-and-billing",
					label: "Admin dashboard",
				});
				const section = params.section ?? "usage-and-billing";
				if (ADMIN_TAB_LABELS[section]) {
					out.push({ label: ADMIN_TAB_LABELS[section] });
				}
				return out;
			}
			case "org-home": {
				const name = orgNameForId ?? "Organisation";
				out.push({ href: `/o/${params.orgId}/overview`, label: name });
				const section = params.section;
				if (section && ORG_SECTION_LABELS[section]) {
					out.push({ label: ORG_SECTION_LABELS[section] });
				}
				return out;
			}
			case "org-settings": {
				const name = orgNameForId ?? "Organisation";
				out.push({ href: `/o/${params.orgId}/overview`, label: name });
				out.push({
					href: `/o/${params.orgId}/settings/general`,
					label: "Settings",
				});
				const section = params.section;
				if (section && ORG_SETTINGS_LABELS[section]) {
					out.push({ label: ORG_SETTINGS_LABELS[section] });
				}
				return out;
			}
			case "workspace-home": {
				if (!workspace) return out;
				pushWorkspaceCrumbs(workspace);
				if (window.location.pathname.endsWith("/projects/new")) {
					out.push({ label: "New project" });
				}
				const section = params.section;
				if (section === "members") {
					out.push({ label: "Members" });
				}
				return out;
			}
			case "workspace-settings": {
				if (workspace) {
					pushWorkspaceCrumbs(workspace);
				}
				out.push({ label: "Settings" });
				const section = params.section;
				if (section && WORKSPACE_SETTINGS_LABELS[section]) {
					out.push({ label: WORKSPACE_SETTINGS_LABELS[section] });
				}
				return out;
			}
			case "project-home": {
				if (workspace) {
					pushWorkspaceCrumbs(workspace);
				}
				if (projectQuery.data?.name) {
					out.push({
						href: `/w/${params.workspaceId}/projects/${params.projectId}/home`,
						label: projectQuery.data.name,
					});
				}
				const section = params.section;
				if (section === "conversations" && params.conversationId) {
					// Detail page: link back to the conversations list first.
					out.push({
						href: `/w/${params.workspaceId}/projects/${params.projectId}/conversations`,
						label: PROJECT_SECTION_LABELS.conversations,
					});
					out.push({
						label:
							conversationQuery.data?.title?.trim() ||
							conversationQuery.data?.participant_name?.trim() ||
							PROJECT_SECTION_LABELS.conversation,
					});
				} else if (
					section === "chats" &&
					params.chatId &&
					params.chatId !== "new"
				) {
					out.push({
						href: `/w/${params.workspaceId}/projects/${params.projectId}/chats/new`,
						label: PROJECT_SECTION_LABELS.chats,
					});
					// An unnamed chat would just repeat the section label; one
					// linked "Ask" crumb reads better than "Ask > Ask".
					const chatName = chatQuery.data?.name?.trim();
					if (chatName) {
						out.push({ label: chatName });
					}
				} else if (
					section &&
					section !== "home" &&
					PROJECT_SECTION_LABELS[section]
				) {
					out.push({ label: PROJECT_SECTION_LABELS[section] });
				}
				return out;
			}
			case "project-settings": {
				if (workspace) {
					pushWorkspaceCrumbs(workspace);
				}
				if (projectQuery.data?.name) {
					out.push({
						href: `/w/${params.workspaceId}/projects/${params.projectId}/home`,
						label: projectQuery.data.name,
					});
				}
				out.push({ label: "Settings" });
				const section = params.section;
				if (section === "access") out.push({ label: "Access" });
				else if (section === "usage") out.push({ label: "Usage" });
				else if (section === "overview") out.push({ label: "General" });
				else if (section === "integrations")
					out.push({ label: "Integrations & Export" });
				return out;
			}
		}
		return out;
	}, [
		view,
		params,
		workspace,
		orgNameForId,
		projectQuery.data?.name,
		conversationQuery.data,
		chatQuery.data,
	]);

	if (crumbs.length === 0) return null;

	return (
		<nav
			className="flex h-[57px] shrink-0 items-center gap-1 text-xs print:hidden"
			aria-label="Breadcrumb"
			style={{
				color: "rgba(45, 45, 44, 0.55)",
				paddingLeft: collapsed ? "52px" : "16px",
				paddingRight: "16px",
			}}
		>
			{crumbs.map((c, i) => {
				const isLast = i === crumbs.length - 1;
				const displayLabel = truncateMiddle(c.label);
				return (
					<span key={`${c.label}-${i}`} className="flex items-center gap-1">
						{i > 0 && <CaretRightIcon size={10} opacity={0.5} />}
						{c.href && !isLast ? (
							<I18nLink
								to={c.href}
								className="truncate hover:underline"
								style={{ color: "rgba(45, 45, 44, 0.75)" }}
								title={c.label}
							>
								{displayLabel}
							</I18nLink>
						) : (
							<span
								className="truncate"
								style={{
									color: isLast ? "#2d2d2c" : "rgba(45, 45, 44, 0.55)",
								}}
								title={c.label}
							>
								{displayLabel}
							</span>
						)}
					</span>
				);
			})}
		</nav>
	);
};
