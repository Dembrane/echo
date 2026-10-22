import { useV2Me } from "@/hooks/useV2Me";
import { useWorkspace } from "@/hooks/useWorkspace";

// Mirrors the server's one-free-org rule from cached data; the 402 stays the guard.
export function useManagedFreeOrg(): {
	orgId: string;
	workspaceId: string;
} | null {
	const { workspaces } = useWorkspace();
	const { data: me } = useV2Me();
	if (!me || me.is_staff) return null;
	for (const org of me.orgs ?? []) {
		if (org.role !== "owner" && org.role !== "admin") continue;
		const ws = (workspaces ?? [])
			.filter((w) => w.org_id === org.id && !w.bills_separately)
			.sort((a, b) => Number(!!b.is_default) - Number(!!a.is_default))[0];
		if (ws?.tier === "free") return { orgId: org.id, workspaceId: ws.id };
	}
	return null;
}
