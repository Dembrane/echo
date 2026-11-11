import { UpgradeModal } from "@/components/workspace/FeatureGate";
import { SELLABLE_TIER } from "@/lib/tiers";
import type { SampleCap } from "./gateWalls";

// The upgrade popup for a free sample project's own caps; the AI budget plays no part.
export function SampleCapWall({
	cap,
	onClose,
	opened,
	projectId,
	questions,
	workspaceId,
}: {
	cap: SampleCap;
	// The cap the chat_turns refusal carried; none falls back to the default.
	questions?: number | null;
	opened: boolean;
	onClose: () => void;
	workspaceId: string;
	projectId?: string;
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
			wallKey="sample_cap"
			sampleCap={cap}
			sampleQuestions={questions}
			entry="modal_direct"
		/>
	);
}
