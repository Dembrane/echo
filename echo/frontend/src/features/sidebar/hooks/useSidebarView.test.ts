import { describe, expect, it } from "vitest";
import { resolveSidebarView } from "./useSidebarView";

describe("project navigation groups", () => {
	it.each(["overview", "access", "usage", "export"])(
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

	it("keeps Automation in the project navigation", () => {
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
