import { QueryClientContext } from "@tanstack/react-query";
import { useCallback, useContext, useMemo, useState } from "react";
import { UpgradeModal } from "@/components/workspace/FeatureGate";
import { invalidateFreeAllowance } from "@/hooks/useFreeAllowance";
import { aiBudgetDetails } from "@/lib/freeTier";
import { SELLABLE_TIER } from "@/lib/tiers";
import type { AiAction } from "./gateWalls";

/** Open state for AiBudgetWall: `openFor` takes a refusal, `open` a known used-up budget. */
export function useAiBudgetWall() {
	// Optional: a refusal also refreshes the meter and banners where a client is mounted.
	const queryClient = useContext(QueryClientContext);
	const [state, setState] = useState({
		opened: false,
		resetsAt: null as string | null,
		usedUp: true,
	});
	const open = useCallback(
		(resetsAt: string | null = null, usedUp = true) =>
			setState({ opened: true, resetsAt, usedUp }),
		[],
	);
	// Keeps the date while closing, so the closing popup does not change.
	const close = useCallback(
		() => setState((s) => ({ ...s, opened: false })),
		[],
	);
	const openFor = useCallback(
		(err: unknown) => {
			const refused = aiBudgetDetails(err);
			if (!refused) return false;
			open(refused.resetsAt);
			if (queryClient) void invalidateFreeAllowance(queryClient);
			return true;
		},
		[open, queryClient],
	);
	const props = useMemo(() => ({ ...state, onClose: close }), [state, close]);
	return { close, open, openFor, props };
}

// The one upgrade popup for a free account whose monthly AI budget is used up.
export function AiBudgetWall({
	action,
	onClose,
	opened,
	projectId,
	resetsAt,
	usedUp = true,
	workspaceId,
}: {
	opened: boolean;
	onClose: () => void;
	// None (the allowance card) opens on the free-plan allowance line, with no attempt named.
	action?: AiAction;
	resetsAt: string | null;
	workspaceId: string;
	projectId?: string;
	// False while the budget still has room: a neutral opening, no used-up block.
	usedUp?: boolean;
}) {
	return (
		<UpgradeModal
			opened={opened}
			onClose={onClose}
			currentTier="free"
			requiredTier={SELLABLE_TIER}
			canRequestUpgrade
			workspaceId={workspaceId}
			projectId={projectId}
			wallKey="ai_budget"
			// Nothing was refused while the budget has room, so no action is named.
			aiAction={usedUp ? action : undefined}
			aiUsedUp={usedUp}
			resetsAt={resetsAt}
			entry="modal_direct"
		/>
	);
}
