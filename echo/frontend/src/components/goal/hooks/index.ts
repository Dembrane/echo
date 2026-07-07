import { t } from "@lingui/core/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/common/Toaster";
import { APP_ENVIRONMENT } from "@/config";
import { bff } from "@/lib/bff";
import { createFixtureProjectGoal } from "../fixtures";

export type GoalSetBy = "interview" | "you" | "loop" | "host-edit" | string;

export type ProjectGoalRevision = {
	id: string;
	content: string;
	set_by: GoalSetBy;
	created_at: string;
};

export type ProjectGoalResponse = {
	current: ProjectGoalRevision | null;
	revisions: ProjectGoalRevision[];
	isDevFixture?: boolean;
};

type BffError = Error & { status?: number };

export const projectGoalQueryKeys = {
	detail: (projectId: string) => ["project", projectId, "goal"] as const,
};

function isFixtureEligibleMiss(error: unknown): boolean {
	const bffError = error as BffError;
	if (APP_ENVIRONMENT !== "local") return false;
	const isLocalNetworkMiss =
		error instanceof TypeError ||
		bffError?.message === "Failed to fetch" ||
		bffError?.message.includes("fetch failed");
	return (
		bffError?.status === 404 ||
		bffError?.message === "HTTP 404" ||
		isLocalNetworkMiss
	);
}

async function getProjectGoal(projectId: string): Promise<ProjectGoalResponse> {
	try {
		return await bff.get<ProjectGoalResponse>(`/projects/${projectId}/goal`);
	} catch (error) {
		if (isFixtureEligibleMiss(error)) {
			return { ...createFixtureProjectGoal(projectId), isDevFixture: true };
		}
		throw error;
	}
}

export function useProjectGoal(projectId: string) {
	return useQuery({
		enabled: !!projectId,
		queryFn: () => getProjectGoal(projectId),
		queryKey: projectGoalQueryKeys.detail(projectId),
	});
}

export function useSaveProjectGoalMutation(projectId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (
			input:
				| string
				| {
						content: string;
						set_by?: "host-edit" | "interview";
						chat_id?: string;
				  },
		) =>
			bff.post<ProjectGoalRevision>(
				`/projects/${projectId}/goal`,
				typeof input === "string" ? { content: input } : input,
			),
		onError: (error: BffError) => {
			toast.error(error.message || t`Could not save this project goal`);
		},
		onSuccess: (revision) => {
			queryClient.setQueryData<ProjectGoalResponse | undefined>(
				projectGoalQueryKeys.detail(projectId),
				(previous) => ({
					current: revision,
					isDevFixture: previous?.isDevFixture,
					revisions: previous?.revisions?.length
						? [revision, ...previous.revisions]
						: [revision],
				}),
			);
			queryClient.invalidateQueries({
				queryKey: projectGoalQueryKeys.detail(projectId),
			});
		},
	});
}
