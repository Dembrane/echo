import { useMemo } from "react";
import { useLocation } from "react-router";
import type { ResolvedSidebarView, SidebarViewId } from "../types";

const LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;

function stripLocale(segments: string[]): string[] {
	if (segments[0] && LOCALE_RE.test(segments[0])) return segments.slice(1);
	return segments;
}

// Temporary: sidebar lives under /sidebar-preview during development.
// Remove once the sidebar replaces production layouts.
const PREVIEW_PREFIX = "sidebar-preview";

function stripPreview(segments: string[]): string[] {
	if (segments[0] === PREVIEW_PREFIX) return segments.slice(1);
	return segments;
}

const OVERLAY_VIEWS = new Set(["inbox", "help"]);

function withoutSidebarSearch(search: string): string {
	const params = new URLSearchParams(search);
	params.delete("sidebar");
	const next = params.toString();
	return next ? `?${next}` : "";
}

export function resolveSidebarView(
	pathname: string,
	search = "",
): ResolvedSidebarView {
	const raw = pathname.split("/").filter(Boolean);
	const segs = stripPreview(stripLocale(raw));

	const overlay = new URLSearchParams(search).get("sidebar");
	if (overlay && OVERLAY_VIEWS.has(overlay)) {
		const base = resolveSidebarView(pathname, withoutSidebarSearch(search));
		if (overlay === "inbox") {
			return {
				backTo: `${pathname}${withoutSidebarSearch(search)}`,
				params: base.params,
				scope: base.scope,
				view: base.view,
				overlay: "inbox",
			};
		}
		return {
			backTo: `${pathname}${withoutSidebarSearch(search)}`,
			params: base.params,
			scope: base.scope,
			view: "help",
			overlay: "help",
		};
	}

	// /settings/* → UserSettings
	if (segs[0] === "settings") {
		return {
			backTo: "/",
			params: { section: segs[1] },
			scope: "user",
			view: "user-settings",
		};
	}

	// /admin/* → AdminHome (staff-only surface)
	if (segs[0] === "admin") {
		return {
			backTo: "/",
			params: { section: segs[1] },
			scope: "admin",
			view: "admin-home",
		};
	}

	// /o/:orgId/...
	if (segs[0] === "o" && segs[1]) {
		const orgId = segs[1];
		if (segs[2] === "settings") {
			return {
				backTo: `/o/${orgId}/overview`,
				params: { orgId, section: segs[3] },
				scope: "org",
				view: "org-settings",
			};
		}
		return {
			backTo: "/",
			params: { orgId, section: segs[2] },
			scope: "org",
			view: "org-home",
		};
	}

	// /w/:workspaceId/...
	if (segs[0] === "w" && segs[1] && segs[1] !== "new") {
		const workspaceId = segs[1];

		// /w/:wsId/projects/:projectId/...
		if (segs[2] === "projects" && segs[3] && segs[3] !== "new") {
			const projectId = segs[3];
			// Settings context: explicit /settings/<section> or the legacy
			// /overview and /access pages which ARE the settings panels.
			if (
				segs[4] === "settings" ||
				segs[4] === "overview" ||
				segs[4] === "access"
			) {
				return {
					backTo: `/w/${workspaceId}/projects/${projectId}/home`,
					params: {
						projectId,
						section: segs[4] === "settings" ? segs[5] : segs[4],
						workspaceId,
					},
					scope: "project",
					view: "project-settings",
				};
			}
			return {
				backTo: `/w/${workspaceId}/home`,
				params: { projectId, section: segs[4], workspaceId },
				scope: "project",
				view: "project-home",
			};
		}

		// /w/:wsId/projects/new and the retired projects index stay in the
		// workspace layer. The content route may redirect, but the sidebar
		// should not open a separate Projects menu anymore.
		if (segs[2] === "projects") {
			return {
				backTo: "/",
				params: { workspaceId },
				scope: "workspace",
				view: "workspace-home",
			};
		}

		// /w/:wsId/settings/*
		if (segs[2] === "settings") {
			return {
				backTo: `/w/${workspaceId}/home`,
				params: { section: segs[3], workspaceId },
				scope: "workspace",
				view: "workspace-settings",
			};
		}

		return {
			backTo: "/",
			params: { section: segs[2], workspaceId },
			scope: "workspace",
			view: "workspace-home",
		};
	}

	return { backTo: null, params: {}, scope: "user", view: "user-home" };
}

export function useSidebarView(): ResolvedSidebarView {
	const { pathname, search } = useLocation();
	return useMemo(
		() => resolveSidebarView(pathname, search),
		[pathname, search],
	);
}

export const VIEW_IDS: readonly SidebarViewId[] = [
	"inbox",
	"help",
	"user-home",
	"user-settings",
	"org-home",
	"org-settings",
	"workspace-home",
	"workspace-settings",
	"project-home",
	"project-settings",
	"admin-home",
] as const;

const VIEW_DEPTH: Record<SidebarViewId, number> = {
	"admin-home": 1,
	help: 9,
	inbox: 9,
	"org-home": 1,
	"org-settings": 2,
	"project-home": 4,
	"project-settings": 5,
	"user-home": 0,
	"user-settings": 1,
	"workspace-home": 2,
	"workspace-settings": 3,
};

export function viewDepth(view: SidebarViewId): number {
	return VIEW_DEPTH[view];
}
