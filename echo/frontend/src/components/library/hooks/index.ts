import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/common/Toaster";
import { generateProjectLibrary, getProjectViews } from "@/lib/api";
import { bff } from "@/lib/bff";

export const useProjectViews = (projectId: string) => {
	return useQuery({
		queryFn: () => getProjectViews(projectId),
		queryKey: ["projects", projectId, "views"],
		refetchInterval: 20000,
	});
};

/** A view with its aspects, the ones with most quotes first. */
export const useViewById = (projectId: string, viewId: string) => {
	return useQuery({
		queryFn: () => bff.get<View>(`/views/${viewId}`),
		queryKey: ["projects", projectId, "views", viewId],
	});
};

/** An aspect with its quotes, each quote with the conversation it came from. */
export const useAspectById = (projectId: string, aspectId: string) => {
	return useQuery({
		queryFn: () => bff.get<Aspect>(`/aspects/${aspectId}`),
		queryKey: ["projects", projectId, "aspects", aspectId],
	});
};

export const useGenerateProjectLibraryMutation = () => {
	const client = useQueryClient();
	return useMutation({
		mutationFn: generateProjectLibrary,
		onSuccess: (_, variables) => {
			toast.success("Analysis requested successfully");
			client.invalidateQueries({ queryKey: ["projects", variables.projectId] });
		},
	});
};
