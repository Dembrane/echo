import { FreeAllowanceBanner } from "@/components/workspace/FreeAllowanceBanner";
import { useAllowanceApplies } from "@/hooks/useAllowanceApplies";
import { useFreeAllowance } from "@/hooks/useFreeAllowance";
import { useProjectRecording } from "@/hooks/useProjectRecording";
import { AUDIO_USED_UP_SLACK_SECONDS } from "@/lib/freeTier";

// Free account whose month's audio or AI is used up: both pause recordings and uploads.
export const AudioUsedUpNotice = ({
	projectId,
	workspaceId,
}: {
	projectId: string;
	workspaceId: string;
}) => {
	const { data } = useProjectRecording(projectId);
	const left = data?.free ? data.audio_seconds_left : null;
	const audioUsedUp = left != null && left < AUDIO_USED_UP_SLACK_SECONDS;
	// Only free accounts read the allowance.
	const { data: allowance } = useFreeAllowance(data?.free ? workspaceId : null);
	const ai = allowance?.free ? allowance.ai : null;
	const aiUsedUp = !!ai && ai.exhausted && !ai.unlimited;
	const { applies } = useAllowanceApplies(
		audioUsedUp || aiUsedUp ? projectId : null,
	);
	if (!applies || (!audioUsedUp && !aiUsedUp)) return null;
	return (
		<>
			{aiUsedUp && (
				<FreeAllowanceBanner workspaceId={workspaceId} feature="ai" />
			)}
			{audioUsedUp && (
				<FreeAllowanceBanner workspaceId={workspaceId} feature="audio" />
			)}
		</>
	);
};
