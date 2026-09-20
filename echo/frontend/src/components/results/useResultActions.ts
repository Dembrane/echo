import { useMutation, useQueryClient } from "@tanstack/react-query";
import posthog from "posthog-js";
import { useCallback, useMemo } from "react";
import {
	type AnalysisRevision,
	analysisKeys,
} from "@/components/analysis/hooks";
import { bff } from "@/lib/bff";
import type { EditableField } from "./resultContent";

/** What a host says they changed when they reword a finding. */
export type WordsChangeKind = "typo" | "clarity" | "meaning";

export type WordsEditInput = {
	objectId: string;
	/** The revision the host was reading when they started typing. */
	expectedRevisionId: string;
	field: EditableField;
	words: string;
	changeKind: WordsChangeKind;
	reason?: string;
};

export type WordsUndoInput = {
	objectId: string;
	/** The wording to come back to: the revision the edit replaced. */
	toRevisionId: string;
	/**
	 * The revision the host's own edit produced. Anyone else's edit since then
	 * makes this a conflict rather than erasing their work.
	 */
	expectedRevisionId: string;
};

/**
 * Holding a finding back from one presentation.
 *
 * **Step 5 changes this one place.** Today the only writer is the draft's
 * `hidden_items` list, which keeps no reason, so `setHeld` collects the
 * reason and drops it. When the curation log endpoint exists, an adapter that
 * posts `{ object_id, action, reason }` replaces this one and nothing else on
 * the screen moves: the prompt, the suggestions and the dimmed row are
 * already here.
 */
export type HoldBackAdapter = {
	isHeld: (objectId: string) => boolean;
	setHeld: (objectId: string, held: boolean, reason: string) => void;
};

const REASON_STORE = "dembrane.holdBackReasons";
const REASONS_KEPT = 4;

/** The reasons this browser has used, the last one first. */
function readReasons(): string[] {
	try {
		const raw = window.localStorage.getItem(REASON_STORE);
		const parsed = raw ? JSON.parse(raw) : [];
		return Array.isArray(parsed)
			? parsed.filter((entry): entry is string => typeof entry === "string")
			: [];
	} catch {
		// A private window, or storage the host has turned off. The prompt then
		// offers its own suggestions and asks for the words.
		return [];
	}
}

function rememberReason(reason: string) {
	try {
		const kept = [reason, ...readReasons().filter((r) => r !== reason)];
		window.localStorage.setItem(
			REASON_STORE,
			JSON.stringify(kept.slice(0, REASONS_KEPT)),
		);
	} catch {
		// Nothing to remember with. The prompt still works.
	}
}

function useWrite(projectId: string, path: string, event: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			body,
			objectId,
		}: {
			objectId: string;
			body: Record<string, unknown>;
		}) =>
			bff.post<{ revision: AnalysisRevision }>(
				`/analysis/projects/${projectId}/objects/${objectId}/${path}`,
				body,
			),
		// No toast: what happened is said in the row, in words, where the host
		// is looking.
		onSuccess: ({ revision }, { objectId }) => {
			// Ids and kinds only: never the words, never a reason.
			posthog.capture(event, {
				object_id: objectId,
				project_id: projectId,
				result_type: revision.type,
			});
			void queryClient.invalidateQueries({
				queryKey: analysisKeys.history(projectId, objectId),
			});
			void queryClient.invalidateQueries({
				queryKey: [...analysisKeys.all, projectId, "objects"],
			});
		},
	});
}

export type ResultActions = {
	/** Reword one field of one finding, saying what kind of change it was. */
	editWords: (input: WordsEditInput) => Promise<AnalysisRevision>;
	/** Take back the host's own edit, against the revision it produced. */
	undoWords: (input: WordsUndoInput) => Promise<AnalysisRevision>;
	/** Whether the presentation this list belongs to holds this finding back. */
	isHeld: (objectId: string) => boolean;
	/** Present only. Null where a list has no presentation behind it. */
	holdBack: ((objectId: string, reason: string) => void) | null;
	showAgain: ((objectId: string, reason: string) => void) | null;
	/** Reasons to offer first, the last one used leading. */
	heldBackReasons: string[];
	pending: boolean;
};

/**
 * Everything a row or an item does to a finding, in one place: rewording,
 * undo, and holding back from a presentation. Withdrawing, restoring and
 * restoring an older wording stay with the item, which owns the history they
 * are read against.
 */
export function useResultActions({
	projectId,
	holdBack,
}: {
	projectId: string;
	holdBack?: HoldBackAdapter | null;
}): ResultActions {
	const edit = useWrite(projectId, "revisions", "analysis_result_edited");
	const rollback = useWrite(projectId, "rollback", "analysis_result_undone");

	const editWords = useCallback(
		async ({
			changeKind,
			expectedRevisionId,
			field,
			objectId,
			reason,
			words,
		}: WordsEditInput) => {
			// The one field that changed, and nothing else: the endpoint takes a
			// patch of allowlisted fields (`RevisionEdit` in
			// `server/dembrane/api/v2/bff/analysis.py`) and keeps the rest of the
			// payload as it stands, evidence and quotes included.
			const { revision } = await edit.mutateAsync({
				body: {
					change_kind: changeKind,
					expected_revision_id: expectedRevisionId,
					patch: { [field]: words },
					reason,
				},
				objectId,
			});
			return revision;
		},
		[edit.mutateAsync],
	);

	const undoWords = useCallback(
		async ({ expectedRevisionId, objectId, toRevisionId }: WordsUndoInput) => {
			const { revision } = await rollback.mutateAsync({
				body: {
					change_kind: "rollback",
					expected_revision_id: expectedRevisionId,
					to_revision_id: toRevisionId,
				},
				objectId,
			});
			return revision;
		},
		[rollback.mutateAsync],
	);

	const heldBackReasons = useMemo(
		() => (holdBack ? readReasons() : []),
		[holdBack],
	);

	return {
		editWords,
		heldBackReasons,
		holdBack: holdBack
			? (objectId, reason) => {
					rememberReason(reason);
					holdBack.setHeld(objectId, true, reason);
				}
			: null,
		isHeld: holdBack ? holdBack.isHeld : () => false,
		pending: edit.isPending || rollback.isPending,
		showAgain: holdBack
			? (objectId, reason) => holdBack.setHeld(objectId, false, reason)
			: null,
		undoWords,
	};
}
