import { useRef, useState } from "react";
import type { AnalysisObject } from "@/components/analysis/hooks";
import {
	type EditableField,
	editableFields,
	fieldWords,
	isEdited,
} from "../resultContent";
import { typoLike, UNDO_SECONDS } from "../resultEditing";
import type { ResultActions, WordsChangeKind } from "../useResultActions";

type Conflict = {
	field: EditableField;
	mine: string;
	theirs: string;
	theirRevisionId: string;
	who: string;
};

type Saved = {
	kind: WordsChangeKind;
	/** The wording to come back to: the revision the first edit replaced. */
	toRevisionId: string;
	/** What the host's own edits produced, to save the undo against. */
	expectedRevisionId: string;
};

const bag = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

/**
 * Edit mode for a whole row.
 *
 * The pencil turns it on and every field of the row becomes a box at once,
 * because a tension is four fields of one thought and asking for them one at a
 * time makes the host do the joining. The words are saved field by field
 * against the revision the one before produced, so the server sees the same
 * ordered edits it would have seen had the host typed them in turn, and the
 * one question about what changed is asked once for the lot.
 */
export function useRowEdit({
	actions,
	item,
}: {
	actions: ResultActions | null;
	item: AnalysisObject;
}) {
	const fields = editableFields(item.type);
	const [on, setOn] = useState(false);
	const [texts, setTexts] = useState<Record<string, string>>({});
	const [asking, setAsking] = useState(false);
	const [saving, setSaving] = useState(false);
	const [failed, setFailed] = useState(false);
	const [refused, setRefused] = useState(false);
	const [saved, setSaved] = useState<Saved | null>(null);
	const [conflict, setConflict] = useState<Conflict | null>(null);
	const [undoFailed, setUndoFailed] = useState(false);
	// A row whose words this host changed on this page keeps its pencil lit
	// even where the list has not caught up with the new revision.
	const [touched, setTouched] = useState(false);
	const pencil = useRef<HTMLButtonElement>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const words = (field: EditableField) => fieldWords(item, field);
	const text = (field: EditableField) => texts[field] ?? words(field);
	const changed = () =>
		fields.filter((field) => text(field).trim() !== words(field).trim());

	const close = () => {
		setOn(false);
		setTexts({});
		setAsking(false);
		setRefused(false);
		window.setTimeout(() => pencil.current?.focus(), 0);
	};

	const start = () => {
		if (!actions) return;
		setFailed(false);
		setConflict(null);
		setTexts(Object.fromEntries(fields.map((field) => [field, words(field)])));
		setOn(true);
	};

	/** Escape: the old words come back, and nothing was sent. */
	const cancel = () => {
		setFailed(false);
		close();
	};

	/**
	 * Enter, or the pencil again. Nothing changed is nothing to ask about: the
	 * row simply leaves edit mode.
	 */
	const commit = () => {
		if (!actions) return close();
		if (changed().length === 0) return close();
		setFailed(false);
		setRefused(false);
		setAsking(true);
	};

	const confirm = async (kind: WordsChangeKind, reason?: string) => {
		if (!actions) return;
		const doing = changed();
		if (doing.length === 0) return close();
		setSaving(true);
		let against = item.revisionId;
		try {
			for (const field of doing) {
				const revision = await actions.editWords({
					changeKind: kind,
					expectedRevisionId: against,
					field,
					objectId: item.objectId,
					reason,
					words: text(field).trim(),
				});
				against = revision.revisionId;
			}
			setSaving(false);
			setTouched(true);
			setSaved({
				expectedRevisionId: against,
				kind,
				toRevisionId: item.revisionId,
			});
			if (timer.current) clearTimeout(timer.current);
			timer.current = setTimeout(() => setSaved(null), UNDO_SECONDS * 1000);
			close();
		} catch (error) {
			setSaving(false);
			const failure = error as { status?: number; detail?: unknown };
			if (failure.status === 409) {
				const current = bag(bag(failure.detail).current);
				const field = doing[0];
				setConflict({
					field,
					mine: text(field).trim(),
					theirRevisionId: String(current.revisionId ?? ""),
					theirs: String(bag(current.payload)[field] ?? ""),
					who: String(current.actorName ?? ""),
				});
				setAsking(false);
				setOn(false);
				return;
			}
			if (failure.status === 422) {
				// The reason is what the server refused: the prompt stays open and
				// asks for it again rather than saying a save failed.
				setRefused(true);
				return;
			}
			// The words are the host's work: they stay in their boxes.
			setAsking(false);
			setFailed(true);
		}
	};

	const undo = async () => {
		if (!actions || !saved) return;
		const target = saved;
		setSaved(null);
		setUndoFailed(false);
		try {
			await actions.undoWords({
				expectedRevisionId: target.expectedRevisionId,
				objectId: item.objectId,
				toRevisionId: target.toRevisionId,
			});
			setTouched(false);
		} catch {
			setUndoFailed(true);
		}
	};

	/**
	 * What `WordsPrompt` and `EditAftermath` read. Those two say the change, the
	 * conflict and the failure in the words the whole dashboard uses, and this
	 * row would otherwise say the same things again in its own.
	 */
	const prompt = {
		asking,
		// "Try again" after a failed save asks the same question again.
		commit: () => {
			setFailed(false);
			setOn(true);
			setAsking(true);
		},
		conflict,
		draft: { failed, refused, saving },
		keepMine: () => {
			if (!conflict) return;
			setTexts((old) => ({ ...old, [conflict.field]: conflict.mine }));
			setConflict(null);
			setOn(true);
			setAsking(true);
		},
		keepTheirs: () => {
			setConflict(null);
			close();
		},
		restore: cancel,
		save: (kind: WordsChangeKind, reason?: string) =>
			void confirm(kind, reason),
		saved,
		typoLikely: (() => {
			const first = changed()[0];
			return first ? typoLike(words(first), text(first)) : true;
		})(),
		undo: () => void undo(),
		undoFailed,
	};

	return {
		asking,
		cancel,
		commit,
		/** Whether anything at all can be written here. */
		editable: Boolean(actions),
		fields,
		/** The pencil is lit for a finding a host has reworded. */
		lit: touched || isEdited(item),
		on,
		pencil,
		prompt,
		set: (field: EditableField, value: string) =>
			setTexts((old) => ({ ...old, [field]: value })),
		start,
		text,
		toggle: () => (on ? commit() : start()),
	};
}

export type RowEdit = ReturnType<typeof useRowEdit>;
