import { useEffect } from "react";
import { useProjectById } from "@/components/project/hooks";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useRecents } from "./useRecents";
import { useSidebarView } from "./useSidebarView";

// Watches the current sidebar view and records recent visits. Mounted
// once in AppSidebar so navigation anywhere in the app feeds the
// recents list.
export function useRecordRecents(): void {
	const { view, params } = useSidebarView();
	const { workspaces } = useWorkspace();
	const { record } = useRecents();

	const projectQuery = useProjectById({
		projectId: params.projectId ?? "",
		query: { fields: ["id", "name"] },
	});

	// Workspace visits
	useEffect(() => {
		if (view !== "workspace-home") return;
		const ws = workspaces.find((w) => w.id === params.workspaceId);
		if (!ws) return;
		record({
			href: `/w/${ws.id}/home`,
			id: ws.id,
			kind: "workspace",
			label: ws.name,
			parent: ws.org_name ?? undefined,
		});
	}, [view, params.workspaceId, workspaces, record]);

	// Project visits
	useEffect(() => {
		if (view !== "project-home" && view !== "project-settings") return;
		const pid = params.projectId;
		const name = projectQuery.data?.name;
		if (!pid || !name) return;
		const ws = workspaces.find((w) => w.id === params.workspaceId);
		record({
			href: `/w/${params.workspaceId}/projects/${pid}/home`,
			id: pid,
			kind: "project",
			label: name,
			parent: ws?.name,
		});
	}, [
		view,
		params.projectId,
		params.workspaceId,
		projectQuery.data?.name,
		workspaces,
		record,
	]);
}
