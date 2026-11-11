import { useFreeAllowance } from "@/hooks/useFreeAllowance";
import { useV2Me } from "@/hooks/useV2Me";
import { isOutsiderRole } from "@/lib/roles";

type CapWorkspace = { id: string; role: string; tier: string };

// Free account at its project cap; staff skip the cap like the server. The 402 stays the guard.
export function useProjectCapStatus(
	workspace: CapWorkspace | null | undefined,
): { atCap: boolean; settled: boolean } {
	const { data: me } = useV2Me();
	const check =
		workspace?.tier === "free" &&
		me?.is_staff === false &&
		!isOutsiderRole(workspace.role);
	const allowance = useFreeAllowance(check ? workspace.id : null).data;
	const atCap =
		check &&
		!!allowance?.free &&
		!!allowance.projects &&
		allowance.projects.used >= allowance.projects.limit;
	// Settled once the answer is known: the allowance read, or no read needed.
	const settled = check ? allowance !== undefined : !!workspace && !!me;
	return { atCap, settled };
}

export const useProjectCap = (workspace: CapWorkspace | null | undefined) =>
	useProjectCapStatus(workspace).atCap;
