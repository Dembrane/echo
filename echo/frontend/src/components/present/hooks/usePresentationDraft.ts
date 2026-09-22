import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import posthog from "posthog-js";
import { useCallback, useRef } from "react";
import type {
	PopcornSettings,
	PopcornSettingsPatch,
} from "@/components/popcorn/hooks";
import { bff } from "@/lib/bff";
import { type Presentation, presentationKey } from ".";

type Draft = {
	presentation: Presentation;
	revision: number;
	has_changes: boolean;
	saved_at?: string;
};

export const presentationDraftKey = (id: string) => ["presentation-draft", id];

// The blocks the server shallow-merges rather than replaces. Everything else
// at the top level is a scalar a patch replaces outright.
const SHALLOW_BLOCKS = [
	"voice",
	"language",
	"intro",
	"data",
	"disclosure",
	"notice",
	"tabs",
] as const;

/**
 * The server's merge semantics, run on the cached draft so a toggle answers at
 * once. Mirrors `merge_settings` in the popcorn service: scalars replace, the
 * named blocks shallow-merge, the presentation manifest shallow-merges with
 * `result_bindings` merged per key so two adopters never drop each other's.
 */
export function mergeDraftSettings(
	current: PopcornSettings,
	patch: PopcornSettingsPatch,
): PopcornSettings {
	const merged = { ...current } as Record<string, unknown>;
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined || value === null) continue;
		if (key === "presentation") {
			const manifest = (current.presentation ?? {}) as Record<string, unknown>;
			const next = { ...manifest, ...(value as Record<string, unknown>) };
			const bindings = (value as { result_bindings?: Record<string, string> })
				.result_bindings;
			if (bindings)
				next.result_bindings = {
					...((manifest.result_bindings as Record<string, string>) ?? {}),
					...bindings,
				};
			merged.presentation = next;
			continue;
		}
		if ((SHALLOW_BLOCKS as readonly string[]).includes(key)) {
			merged[key] = {
				...((current[key as keyof PopcornSettings] as object) ?? {}),
				...(value as object),
			};
			continue;
		}
		merged[key] = value;
	}
	return merged as PopcornSettings;
}

const withPatch = (
	draft: Draft,
	patch: PopcornSettingsPatch,
	has_changes = true,
): Draft => ({
	...draft,
	has_changes,
	presentation: {
		...draft.presentation,
		settings: mergeDraftSettings(draft.presentation.settings, patch),
	},
});

export function usePresentationDraft(
	projectId: string,
	id: string,
	enabled: boolean,
) {
	const client = useQueryClient();
	const key = presentationDraftKey(id);
	const revision = useRef(0);
	// Every optimistic patch takes the next number. A failed save may only put
	// its snapshot back while it is still the last one written, otherwise a
	// patch queued behind it would be erased and the editor would show a value
	// the host never chose.
	const applied = useRef(0);
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
		// Signed out or not allowed to edit is an answer, not a failure to retry.
		retry: (count, error) =>
			count < 3 &&
			![401, 403, 404].includes((error as { status?: number }).status ?? 0),
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
		onError: (_error, _patch, context) => {
			if (!context) return;
			if (context.seq !== applied.current || !context.previous) {
				// Another patch landed after this one: its value, not this stale
				// snapshot, is what the draft should show. Read the draft back.
				void client.invalidateQueries({ queryKey: key });
				return;
			}
			client.setQueryData(key, context.previous);
		},
		onMutate: async (patch: PopcornSettingsPatch) => {
			await client.cancelQueries({ queryKey: key });
			const previous = client.getQueryData<Draft>(key);
			const seq = ++applied.current;
			if (previous) client.setQueryData(key, withPatch(previous, patch));
			return { previous, seq };
		},
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
				project_id: projectId || draft.presentation.project_id,
			});
			accept(draft);
			client.invalidateQueries({ queryKey: presentationKey(projectId) });
		},
		scope: { id: `presentation-draft-${id}` },
	});
	// Words typed on a slide the room is looking at. The server writes them to
	// the published presentation and to the draft in one go and leaves the rest
	// of the draft unpublished. It shares the saves' scope, so it never overtakes
	// an autosave, and it merges by field on the server, so it sends no revision.
	const publishOpening = useMutation({
		mutationFn: (patch: PopcornSettingsPatch) =>
			bff.post<Draft>(`${path}/opening`, { patch }),
		mutationKey: key,
		onError: () => {
			void client.invalidateQueries({ queryKey: key });
		},
		onMutate: async (patch: PopcornSettingsPatch) => {
			await client.cancelQueries({ queryKey: key });
			const previous = client.getQueryData<Draft>(key);
			applied.current += 1;
			// The words are live as well, so they add nothing unpublished.
			if (previous)
				client.setQueryData(
					key,
					withPatch(previous, patch, previous.has_changes),
				);
		},
		onSuccess: (draft) => {
			accept(draft);
			const project = projectId || draft.presentation.project_id;
			if (project)
				client.invalidateQueries({ queryKey: presentationKey(project) });
			client.invalidateQueries({ queryKey: ["presentation-audience"] });
		},
		scope: { id: `presentation-draft-${id}` },
	});
	return { publish, publishOpening, query, save };
}

/**
 * The save behind typing into the opening's words on the slide itself. `live`
 * is a screen showing the published presentation: there the edited words go to
 * the room at once and into the draft with them, while anything else waiting
 * in the draft stays unpublished. Elsewhere it is the editor's own draft patch,
 * so the editor's fields and the slide never disagree. Undefined until the
 * draft has loaded, which only happens for a host who may edit: nobody else is
 * offered the affordance.
 */
export function useOpeningInlineEdit(
	draft: ReturnType<typeof usePresentationDraft>,
	live: boolean,
) {
	const { mutateAsync: save } = draft.save;
	const { mutateAsync: publishOpening } = draft.publishOpening;
	const edit = useCallback(
		(patch: PopcornSettingsPatch) =>
			live ? publishOpening(patch) : save(patch),
		[live, publishOpening, save],
	);
	return draft.query.isSuccess ? edit : undefined;
}
