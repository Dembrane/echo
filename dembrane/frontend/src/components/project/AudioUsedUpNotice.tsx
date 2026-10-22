import { FreeAllowanceBanner } from "@/components/workspace/FreeAllowanceBanner";
import { useAllowanceApplies } from "@/hooks/useAllowanceApplies";
import { useProjectRecording } from "@/hooks/useProjectRecording";
import { AUDIO_USED_UP_SLACK_SECONDS } from "@/lib/freeTier";

// Free account with this month's audio used up; the allowance is only read then.
export const AudioUsedUpNotice = ({
	projectId,
	workspaceId,
}: {
	projectId: string;
	workspaceId: string;
}) => {
	const { data } = useProjectRecording(projectId);
	const left = data?.free ? data.audio_seconds_left : null;
	const usedUp = left != null && left < AUDIO_USED_UP_SLACK_SECONDS;
	const { applies } = useAllowanceApplies(usedUp ? projectId : null);
	if (!usedUp || !applies) return null;
	return <FreeAllowanceBanner workspaceId={workspaceId} feature="audio" />;
};
