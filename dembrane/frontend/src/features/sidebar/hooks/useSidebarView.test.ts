import { describe, expect, it } from "vitest";
import { resolveSidebarView } from "./useSidebarView";

describe("project navigation groups", () => {
	it.each(["overview", "access", "usage", "export", "advanced"])(
		"opens %s inside Manage",
		(section) => {
			expect(
				resolveSidebarView(`/en-US/w/workspace/projects/project/${section}`),
			).toMatchObject({
				params: { projectId: "project", section, workspaceId: "workspace" },
				scope: "project",
				view: "project-settings",
			});
		},
	);

	// ECHO-1060: the portal editor pushes its own menu; Brief stays in the project's.
	it("opens the portal editor's pages in its own menu", () => {
		expect(
			resolveSidebarView(
				"/en-US/w/workspace/projects/project/portal/about/tags",
			),
		).toMatchObject({
			backTo: "/w/workspace/projects/project/home",
			params: {
				projectId: "project",
				section: "about",
				workspaceId: "workspace",
			},
			scope: "project",
			view: "project-portal",
		});
		expect(
			resolveSidebarView("/w/workspace/projects/project/brief"),
		).toMatchObject({ params: { section: "brief" }, view: "project-home" });
	});

	it("keeps the retired Automation address in the project navigation", () => {
		expect(
			resolveSidebarView("/w/workspace/projects/project/integrations"),
		).toMatchObject({
			params: {
				projectId: "project",
				section: "integrations",
				workspaceId: "workspace",
			},
			scope: "project",
			view: "project-home",
		});
	});
});
