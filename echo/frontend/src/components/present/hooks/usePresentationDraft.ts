import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import posthog from "posthog-js";
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
	const path = `/present/${encodeURIComponent(id)}`;
	const query = useQuery({
		enabled,
		queryFn: async () => {
			const draft = await bff.get<Draft>(`${path}/draft`);
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
	const isConflict = (error: unknown) =>
		(error as { status?: number } | null)?.status === 409;
	const send = (patch: PopcornSettingsPatch) =>
		bff.patch<Draft>(`${path}/draft`, {
			expected_revision: revision.current,
			patch,
		});
	const save = useMutation({
		// The draft moved on elsewhere (another tab, another host). A patch only
		// names the fields this editor changed and the server merges it onto the
		// latest draft, so it is sent once more against the revision found there.
		mutationFn: async (patch: PopcornSettingsPatch) => {
			try {
				return await send(patch);
			} catch (error) {
				if (!isConflict(error)) throw error;
				revision.current = (await bff.get<Draft>(`${path}/draft`)).revision;
				return await send(patch);
			}
		},
		mutationKey: key,
		onSuccess: accept,
		scope: { id: `presentation-draft-${id}` },
	});
	const publish = useMutation({
		mutationFn: () =>
			bff.post<Draft>(`${path}/publish`, {
				expected_revision: revision.current,
			}),
		// Publishing a draft someone else changed is the host's call, not a
		// silent retry: load what is there so the next Publish is against it.
		onError: (error) => {
			if (isConflict(error)) void client.invalidateQueries({ queryKey: key });
		},
		onSuccess: (draft) => {
			// Ids only: never a title, a block's contents or a phrase.
			posthog.capture("presentation_published", {
				presentation_id: id,
				project_id: projectId,
			});
			accept(draft);
			client.invalidateQueries({ queryKey: presentationKey(projectId) });
		},
		scope: { id: `presentation-draft-${id}` },
	});
	return { publish, query, save };
}
