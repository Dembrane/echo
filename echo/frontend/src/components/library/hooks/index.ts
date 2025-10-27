import { readItem } from "@directus/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/common/Toaster";
import { generateProjectLibrary, getProjectViews } from "@/lib/api";
import { directus } from "@/lib/directus";

export const useProjectViews = (projectId: string) => {
	return useQuery({
		queryFn: () => getProjectViews(projectId),
		queryKey: ["projects", projectId, "views"],
		refetchInterval: 20000,
	});
};

export const useViewById = (projectId: string, viewId: string) => {
	return useQuery({
		queryFn: () =>
			directus.request<View>(
				readItem("view", viewId, {
					deep: {
						// get the aspects that have at least one aspect segment
						aspects: {
							_sort: "-count(aspect_segment)",
						} as any,
					},
					fields: [
						"id",
						"name",
						"summary",
						"created_at",
						{
							aspects: [
								"id",
								"name",
								"short_summary",
								"description",
								"image_url",
								"view_id",
								"image_generation_model",
							],
						},
					],
				}),
			),
		queryKey: ["projects", projectId, "views", viewId],
	});
};

export const useAspectById = (projectId: string, aspectId: string) => {
	return useQuery({
		queryFn: () =>
			directus.request<Aspect>(
				readItem("aspect", aspectId, {
					fields: [
						"id",
						"name",
						"image_url",
						"long_summary",
						{
							aspect_segment: [
								"id",
								"description",
								"verbatim_transcript",
								"relevant_index",
								{
									segment: [
										"id",
										{
											conversation_id: ["id", "participant_name"],
										},
									],
								},
							],
						},
					],
				}),
			),
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
