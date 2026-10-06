import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import posthog from "posthog-js";
import { useRef, useState } from "react";
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

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

/**
 * How many fields the draft holds that the room isn't showing: a top-level
 * setting counts once, a block once per field changed inside it. The bindings
 * to results advance outside the editor and are never a change of the host's.
 */
export function countChangedFields(
	draft: PopcornSettings,
	shown: PopcornSettings,
): number {
	const a = draft as Record<string, unknown>;
	const b = shown as Record<string, unknown>;
	const same = (x: unknown, y: unknown) =>
		JSON.stringify(x ?? null) === JSON.stringify(y ?? null);
	let count = 0;
	for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
		if (key.startsWith("_")) continue;
		const [x, y] = [a[key], b[key]];
		if (isPlainObject(x) && isPlainObject(y)) {
			for (const field of new Set([...Object.keys(x), ...Object.keys(y)])) {
				if (key === "presentation" && field === "result_bindings") continue;
				if (!same(x[field], y[field])) count += 1;
			}
		} else if (!same(x, y)) count += 1;
	}
	return count;
}

// How long after the last saved field a draft nobody is watching goes out.
const SHOW_AFTER_MS = 300;

const withPatch = (draft: Draft, patch: PopcornSettingsPatch): Draft => ({
	...draft,
	has_changes: true,
	presentation: {
		...draft.presentation,
		settings: mergeDraftSettings(draft.presentation.settings, patch),
	},
});

export function usePresentationDraft(
	projectId: string,
	id: string,
	enabled: boolean,
	{
		showAsSaved = false,
	}: {
		/**
		 * Nobody is watching the room: every saved field goes straight on to the
		 * screen. Otherwise the draft keeps it until the host shows it.
		 */
		showAsSaved?: boolean;
	} = {},
) {
	const client = useQueryClient();
	const key = presentationDraftKey(id);
	const autoShow = useRef(showAsSaved);
	autoShow.current = showAsSaved;
	const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	// A saved field on its way to the screen, so the page doesn't call it
	// waiting for the moment between the save and the show.
	const [showQueued, setShowQueued] = useState(false);
	// Saves that show themselves (see saveAndShow) leave the timer alone.
	const showing = useRef(0);
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
			setShowQueued(false);
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
		onSuccess: (draft) => {
			accept(draft);
			if (autoShow.current && !showing.current && draft.has_changes) showSoon();
		},
		scope: { id: `presentation-draft-${id}` },
	});
	// Fields save one by one as the host types; the draft goes out once they
	// settle. A save still in flight schedules this again when it lands.
	const showSoon = () => {
		if (showTimer.current) clearTimeout(showTimer.current);
		setShowQueued(true);
		showTimer.current = setTimeout(() => {
			showTimer.current = null;
			if (client.isMutating({ mutationKey: key })) return;
			setShowQueued(false);
			if (!autoShow.current || !client.getQueryData<Draft>(key)?.has_changes)
				return;
			publish.mutate();
		}, SHOW_AFTER_MS);
	};
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
	/** A change that shows at once, whoever is watching, with all that waited. */
	const saveAndShow = async (patch: PopcornSettingsPatch) => {
		showing.current += 1;
		try {
			await save.mutateAsync(patch);
		} finally {
			showing.current -= 1;
		}
		return publish.mutateAsync();
	};
	return { publish, query, save, saveAndShow, showQueued };
}
