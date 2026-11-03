import { UpgradeModal } from "@/components/workspace/FeatureGate";
import { SELLABLE_TIER } from "@/lib/tiers";
import type { AiAction } from "./gateWalls";

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
	// None reads as "use AI features" (the allowance card names no action).
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
