import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import type { PopcornSettingsPatch } from "@/components/popcorn/hooks";
import { bff } from "@/lib/bff";
import { type Presentation, presentationKey } from ".";

type Draft = {
	presentation: Presentation;
	revision: number;
	has_changes: boolean;
	saved_at?: string;
};

export function usePresentationDraft(
	projectId: string,
	id: string,
	enabled: boolean,
) {
	const client = useQueryClient();
	const key = ["presentation-draft", id];
	const revision = useRef(0);
	const query = useQuery({
		enabled,
		queryFn: async () => {
			const draft = await bff.get<Draft>(
				`/present/${encodeURIComponent(id)}/draft`,
			);
			revision.current = draft.revision;
			return draft;
		},
		queryKey: key,
		refetchOnWindowFocus: false,
	});
	const accept = (draft: Draft) => {
		revision.current = draft.revision;
		client.setQueryData(key, draft);
	};
	const save = useMutation({
		mutationFn: (patch: PopcornSettingsPatch) =>
			bff.patch<Draft>(`/present/${encodeURIComponent(id)}/draft`, {
				expected_revision: revision.current,
				patch,
			}),
		mutationKey: key,
		onSuccess: accept,
		scope: { id: `presentation-draft-${id}` },
	});
	const publish = useMutation({
		mutationFn: () =>
			bff.post<Draft>(`/present/${encodeURIComponent(id)}/publish`, {
				expected_revision: revision.current,
			}),
		onSuccess: (draft) => {
			accept(draft);
			client.invalidateQueries({ queryKey: presentationKey(projectId) });
		},
		scope: { id: `presentation-draft-${id}` },
	});
	return { publish, query, save };
}
