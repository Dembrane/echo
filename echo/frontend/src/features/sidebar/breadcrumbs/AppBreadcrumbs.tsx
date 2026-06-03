import { CaretRight } from "@phosphor-icons/react";
import { useMemo } from "react";
import { useParams } from "react-router";
import { I18nLink } from "@/components/common/i18nLink";
import { useProjectById } from "@/components/project/hooks";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useSidebarView } from "../hooks/useSidebarView";

interface Crumb {
	label: string;
	href?: string;
}

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
	access: "Access & sharing",
	chats: "Ask",
	conversation: "Conversation",
	conversations: "Conversations",
	export: "Export",
	home: "Overview",
	"host-guide": "Host guide",
	integrations: "Integrations",
	library: "Explore",
	overview: "Settings",
	portal: "Portal editor",
	"portal-editor": "Portal editor",
	report: "Report",
	upload: "Upload",
};

const USER_SETTINGS_LABELS: Record<string, string> = {
	access: "My access",
	account: "Account & security",
	appearance: "Appearance",
	"project-defaults": "Project defaults",
};

const ORG_SECTION_LABELS: Record<string, string> = {
	billing: "Billing",
	overview: "Overview",
	people: "Members",
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
		const out: Crumb[] = [{ href: "/", label: "Home" }];
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
				out.push({
					href: `/w/${workspace.id}/home`,
					label: workspace.name,
				});
				if (window.location.pathname.endsWith("/projects/new")) {
					out.push({ label: "New project" });
				}
				return out;
			}
			case "workspace-settings": {
				if (workspace) {
					out.push({
						href: `/w/${workspace.id}/home`,
						label: workspace.name,
					});
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
					out.push({
						href: `/w/${workspace.id}/home`,
						label: workspace.name,
					});
				}
				if (projectQuery.data?.name) {
					out.push({
						href: `/w/${params.workspaceId}/projects/${params.projectId}/home`,
						label: projectQuery.data.name,
					});
				}
				const section = params.section;
				if (section && section !== "home" && PROJECT_SECTION_LABELS[section]) {
					out.push({ label: PROJECT_SECTION_LABELS[section] });
				}
				return out;
			}
			case "project-settings": {
				if (workspace) {
					out.push({
						href: `/w/${workspace.id}/home`,
						label: workspace.name,
					});
				}
				if (projectQuery.data?.name) {
					out.push({
						href: `/w/${params.workspaceId}/projects/${params.projectId}/home`,
						label: projectQuery.data.name,
					});
				}
				out.push({ label: "Settings" });
				const section = params.section;
				if (section === "access") out.push({ label: "Access & sharing" });
				else if (section === "overview") out.push({ label: "General" });
				return out;
			}
		}
		return out;
	}, [view, params, workspace, orgNameForId, projectQuery.data?.name]);

	if (crumbs.length === 0) return null;

	return (
		<nav
			className="flex h-[57px] shrink-0 items-center gap-1 px-4 text-[12px] print:hidden"
			aria-label="Breadcrumb"
			style={{ color: "rgba(45, 45, 44, 0.55)" }}
		>
			{crumbs.map((c, i) => {
				const isLast = i === crumbs.length - 1;
				return (
					<span key={`${c.label}-${i}`} className="flex items-center gap-1">
						{i > 0 && <CaretRight size={10} opacity={0.5} />}
						{c.href && !isLast ? (
							<I18nLink
								to={c.href}
								className="truncate hover:underline"
								style={{ color: "rgba(45, 45, 44, 0.75)" }}
							>
								{c.label}
							</I18nLink>
						) : (
							<span
								className="truncate"
								style={{
									color: isLast ? "#2d2d2c" : "rgba(45, 45, 44, 0.55)",
								}}
							>
								{c.label}
							</span>
						)}
					</span>
				);
			})}
		</nav>
	);
};
