import { t } from "@lingui/core/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import posthog from "posthog-js";
import { toast } from "@/components/common/Toaster";
import type {
	PopcornDetail,
	PopcornLanguage,
} from "@/components/popcorn/hooks";
import { bff } from "@/lib/bff";

export type Block = "popcorn" | "stakeholders" | "tensions" | "map";
export type PresentationManifest = {
	version: number;
	blocks: Block[];
	opening: Block | null;
	language_policy: "project" | "explicit";
	hidden_items: string[];
	result_bindings: Partial<Record<Block, string>>;
};
export type Presentation = PopcornDetail & {
	effective_language: PopcornLanguage;
	project_language: {
		code: string;
		fallback: "multilingual" | "not_set" | null;
	};
};
export const presentationKey = (projectId: string) => [
	"project",
	projectId,
	"presentation",
];
export const usePresentation = (projectId: string) =>
	useQuery({
		enabled: !!projectId,
		queryFn: () =>
			bff.get<{ presentation: Presentation | null; can_edit: boolean }>(
				`/present/projects/${encodeURIComponent(projectId)}`,
			),
		queryKey: presentationKey(projectId),
	});
export const useEnsurePresentation = (projectId: string) => {
	const client = useQueryClient();
	return useMutation({
		mutationFn: (prepare: boolean) =>
			bff.post<Presentation>(
				`/present/projects/${encodeURIComponent(projectId)}/${prepare ? "start" : "default"}`,
			),
		onError: () => toast.error(t`Could not open the presentation. Try again.`),
		onSuccess: (presentation, prepare) => {
			// Ids and kinds only: never a title, a block's contents or a phrase.
			posthog.capture("presentation_opened", {
				prepared: prepare,
				presentation_id: presentation.id,
				project_id: projectId,
			});
			client.setQueryData(presentationKey(projectId), {
				can_edit: true,
				presentation,
			});
			client.invalidateQueries({ queryKey: ["project", projectId, "popcorn"] });
		},
	});
};
