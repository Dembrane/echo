import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { API_BASE_URL } from "@/config";
import { ensureOk } from "@/lib/errors/read";

export interface RecordingStatus {
	free: boolean;
	is_recording_project: boolean;
	recording_project: { id: string; name: string; workspace_id: string } | null;
	can_switch: boolean;
	audio_seconds_left: number | null;
	file_limit_seconds: number | null;
}

export const projectRecordingQueryKey = (projectId: string) =>
	["project", projectId, "recording"] as const;

const recordingUrl = (projectId: string) =>
	`${API_BASE_URL}/v2/projects/${projectId}/recording`;

export const useProjectRecording = (projectId: string | null | undefined) =>
	useQuery({
		enabled: !!projectId,
		queryFn: async () => {
			const res = await ensureOk(
				await fetch(recordingUrl(projectId ?? ""), { credentials: "include" }),
			);
			return (await res.json()) as RecordingStatus;
		},
		queryKey: projectRecordingQueryKey(projectId ?? ""),
		staleTime: 60_000,
	});

// Free and not the recording project: recordings and uploads go elsewhere.
export const recordingPaused = (
	status: RecordingStatus | undefined,
): status is RecordingStatus & {
	recording_project: NonNullable<RecordingStatus["recording_project"]>;
} =>
	!!status?.free && !status.is_recording_project && !!status.recording_project;

export const useUseForRecordings = (projectId: string) => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async () => {
			const res = await ensureOk(
				await fetch(recordingUrl(projectId), {
					credentials: "include",
					method: "POST",
				}),
			);
			return (await res.json()) as RecordingStatus;
		},
		onSuccess: (next) => {
			queryClient.setQueryData(projectRecordingQueryKey(projectId), next);
			void queryClient.invalidateQueries({
				predicate: ({ queryKey }) =>
					queryKey[0] === "project" && queryKey[2] === "recording",
			});
			void queryClient.invalidateQueries({
				predicate: ({ queryKey }) =>
					queryKey[0] === "workspace" && queryKey[2] === "free-allowance",
			});
		},
	});
};
