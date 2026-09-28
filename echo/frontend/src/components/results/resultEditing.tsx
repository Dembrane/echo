import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import type { AnalysisObject } from "@/components/analysis/hooks";
import { ReasonPrompt } from "./ReasonPrompt";
import classes from "./ResultsList.module.css";
import {
	type EditableField,
	fieldWords,
	isMultiline,
	MEANING_REASON_MIN,
} from "./resultContent";
import type { ResultActions, WordsChangeKind } from "./useResultActions";

/** How long "Saved as a typo. Undo" stays in the meta line. */
export const UNDO_SECONDS = 10;

/** A change of three characters or fewer is a typo until the host says else. */
const TYPO_DISTANCE = 3;

type Draft = {
	field: EditableField;
	text: string;
	/** The words as they were, for Escape and for the undo that follows. */
	before: string;
	fromRevisionId: string;
	/** The prompt has the meta line; the new words wait in soft ink. */
	asking: boolean;
	saving: boolean;
	failed: boolean;
	/** The server would not take the reason: the prompt asks again. */
	refused: boolean;
};

type Saved = {
	kind: WordsChangeKind;
	toRevisionId: string;
	expectedRevisionId: string;
};

type Conflict = {
	field: EditableField;
	mine: string;
	theirs: string;
	/** The revision to save against if the host keeps their own words. */
	theirRevisionId: string;
	who: string;
};

const bag = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

/** Whether two wordings are close enough that the prompt rests on "A typo". */
export const typoLike = (before: string, after: string): boolean =>
	distance(before.trim(), after.trim()) <= TYPO_DISTANCE;

/** How far apart two wordings are, cheaply: enough to spot a typo fix. */
function distance(before: string, after: string): number {
	if (before === after) return 0;
	const shift = Math.abs(before.length - after.length);
	const shared = Math.min(before.length, after.length);
	let changed = 0;
	for (let at = 0; at < shared; at += 1)
		if (before[at] !== after[at]) changed += 1;
	return shift + changed;
}

function whoWord(revision: Record<string, unknown>, name?: string): string {
	const at = revision.publishedAt;
	const when = typeof at === "string" ? new Date(at) : null;
	const minutes =
		when && !Number.isNaN(when.getTime())
			? Math.round((Date.now() - when.getTime()) / 60000)
			: null;
	const said = name ?? t`Someone else`;
	if (minutes === null) return said;
	const ago = new Intl.RelativeTimeFormat(undefined, {
		numeric: "auto",
	}).format(-Math.max(minutes, 0), "minute");
	return `${said}, ${ago}`;
}

export type WordsEdit = ReturnType<typeof useWordsEdit>;

/**
 * Rewording a finding in place: the words, the prompt that asks what changed,
 * the ten seconds of undo after it, a failed save that keeps the host's words
 * and a conflict that shows both wordings.
 *
 * The state lives here because the prompt takes over a meta line somewhere
 * else in the row, while the words stay where they are.
 */
export function useWordsEdit({
	item,
	actions,
	actorName,
}: {
	item: AnalysisObject;
	actions: Pick<ResultActions, "editWords" | "undoWords"> | null;
	actorName?: (actorId: string) => string | undefined;
}) {
	const [draft, setDraft] = useState<Draft | null>(null);
	const [saved, setSaved] = useState<Saved | null>(null);
	const [conflict, setConflict] = useState<Conflict | null>(null);
	const [undoFailed, setUndoFailed] = useState(false);
	const [seen, setSeen] = useState(item.revisionId);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Where the caret goes back to when a step ends. The words are a control
	// React draws again after every step, so what is kept is the row it lives
	// in and the name of the control, not the node itself.
	const focusBack = useRef<{ root: Element; testId: string } | null>(null);

	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
		},
		[],
	);

	// Someone else's revision arrived while nothing was in the hand: the row
	// simply reads the new words.
	if (seen !== item.revisionId) {
		setSeen(item.revisionId);
		if (saved && saved.expectedRevisionId !== item.revisionId) setSaved(null);
	}

	const restFocus = () => {
		const back = focusBack.current;
		focusBack.current = null;
		if (!back) return;
		// After Cancel or a confirmation the caret goes back to the control the
		// host opened the step with, never to the top of the page.
		window.setTimeout(() => {
			back.root
				.querySelector<HTMLElement>(`[data-testid="${back.testId}"]`)
				?.focus();
		}, 0);
	};

	const begin = (field: EditableField, from?: HTMLElement | null) => {
		if (!actions) return;
		const root = from?.closest("li, [data-testid='result-item']");
		focusBack.current =
			root && from?.dataset.testid
				? { root, testId: from.dataset.testid }
				: null;
		setConflict(null);
		setDraft({
			asking: false,
			before: fieldWords(item, field),
			failed: false,
			field,
			fromRevisionId: item.revisionId,
			refused: false,
			saving: false,
			text: fieldWords(item, field),
		});
	};

	/** Escape: the old words come back, and nothing was sent. */
	const restore = () => {
		setDraft(null);
		setConflict(null);
		restFocus();
	};

	/**
	 * Enter, or the words losing focus. Blur never discards: the new words
	 * wait in soft ink with the prompt open until the host answers.
	 */
	const commit = () => {
		setDraft((current) => {
			if (!current || current.asking) return current;
			if (current.text.trim() === current.before.trim()) {
				restFocus();
				return null;
			}
			return {
				...current,
				asking: true,
				failed: false,
				refused: false,
			};
		});
	};

	const save = async (
		kind: WordsChangeKind,
		reason?: string,
		against?: string,
	) => {
		if (!actions || !draft) return;
		const words = draft.text.trim();
		setDraft({
			...draft,
			asking: true,
			failed: false,
			refused: false,
			saving: true,
		});
		try {
			const revision = await actions.editWords({
				changeKind: kind,
				expectedRevisionId: against ?? draft.fromRevisionId,
				field: draft.field,
				objectId: item.objectId,
				reason,
				words,
			});
			setDraft(null);
			setConflict(null);
			setSaved({
				expectedRevisionId: revision.revisionId,
				kind,
				toRevisionId: draft.fromRevisionId,
			});
			if (timer.current) clearTimeout(timer.current);
			timer.current = setTimeout(() => setSaved(null), UNDO_SECONDS * 1000);
			restFocus();
		} catch (error) {
			const failure = error as { status?: number; detail?: unknown };
			if (failure.status === 409) {
				const current = bag(bag(failure.detail).current);
				const actorId = current.actorId;
				setConflict({
					field: draft.field,
					mine: words,
					theirRevisionId: String(current.revisionId ?? ""),
					theirs: String(bag(current.payload)[draft.field] ?? ""),
					who: whoWord(
						current,
						typeof actorId === "string" ? actorName?.(actorId) : undefined,
					),
				});
				setDraft(null);
				return;
			}
			if (failure.status === 422) {
				// The reason is what the server refused. The prompt stays open and
				// asks for it in the same words it would have, rather than telling
				// the host their save failed.
				setDraft({
					...draft,
					asking: true,
					failed: false,
					refused: true,
					saving: false,
				});
				return;
			}
			// The words are the host's work: they stay in the field.
			setDraft({
				...draft,
				asking: false,
				failed: true,
				refused: false,
				saving: false,
			});
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
		} catch {
			// Someone edited after this host did: the undo would erase their work,
			// so it conflicts and their words stand.
			setUndoFailed(true);
		}
	};

	const keepMine = () => {
		if (!conflict) return;
		setDraft({
			asking: true,
			before: conflict.theirs,
			failed: false,
			field: conflict.field,
			fromRevisionId: conflict.theirRevisionId,
			refused: false,
			saving: false,
			text: conflict.mine,
		});
		setConflict(null);
	};

	const keepTheirs = () => {
		setConflict(null);
		setDraft(null);
		restFocus();
	};

	return {
		/** The words to draw for this field, and how they read. */
		asking: draft?.asking ?? false,
		begin,
		commit,
		conflict,
		draft,
		editable: Boolean(actions),
		keepMine,
		keepTheirs,
		restore,
		save,
		saved,
		/** Whether the prompt should rest on "A typo". */
		typoLikely: draft
			? distance(draft.before.trim(), draft.text.trim()) <= TYPO_DISTANCE
			: false,
		undo,
		undoFailed,
		update: (text: string) =>
			setDraft((current) => (current ? { ...current, text } : current)),
	};
}

/**
 * The words of one field, read or written in the same place, in the same
 * type. The box takes the words' own size from a sizer behind it, so nothing
 * moves when the caret lands.
 */
export function EditableWords({
	edit,
	field,
	words,
	className,
	label,
	clamp,
}: {
	edit: WordsEdit;
	field: EditableField;
	words: string;
	className?: string;
	label: string;
	/** The class that clamps the resting words, lifted before the caret lands. */
	clamp?: string;
}) {
	const box = useRef<HTMLTextAreaElement>(null);
	const typing = edit.draft?.field === field && !edit.draft.asking;
	const waiting = edit.draft?.field === field && edit.draft.asking;

	useEffect(() => {
		if (!typing) return;
		const field = box.current;
		if (!field) return;
		field.focus();
		field.setSelectionRange(field.value.length, field.value.length);
	}, [typing]);

	if (!edit.editable) return <span className={className}>{words}</span>;

	if (waiting)
		return (
			// The new words wait here, in soft ink, until the host answers the
			// prompt. Nothing has been sent.
			<span className={`${className ?? ""} ${classes.waiting}`}>
				{edit.draft?.text}
			</span>
		);

	if (typing) {
		const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
			if (event.key === "Escape") {
				event.stopPropagation();
				event.preventDefault();
				edit.restore();
				return;
			}
			if (event.key !== "Enter") return;
			const multi = isMultiline(field);
			if (multi && !(event.metaKey || event.ctrlKey)) return;
			event.preventDefault();
			edit.commit();
		};
		return (
			<span className={`${classes.editing} ${className ?? ""}`}>
				{/* The sizer keeps the box exactly the size of the words. */}
				<span aria-hidden className={classes.sizer}>
					{`${edit.draft?.text ?? ""}​`}
				</span>
				<textarea
					ref={box}
					aria-label={label}
					className={classes.words}
					data-edit=""
					data-testid={`result-words-${field}`}
					rows={1}
					value={edit.draft?.text ?? ""}
					onBlur={edit.commit}
					onChange={(event) => edit.update(event.currentTarget.value)}
					onKeyDown={onKeyDown}
				/>
			</span>
		);
	}

	return (
		<button
			type="button"
			aria-label={label}
			className={`${classes.wordsButton} ${clamp ?? ""} ${className ?? ""}`}
			data-testid={`result-edit-${field}`}
			onClick={(event) => {
				event.stopPropagation();
				edit.begin(field, event.currentTarget);
			}}
		>
			{words}
		</button>
	);
}

/**
 * What the prompt and the line after it read. `useWordsEdit` answers to it,
 * and so does the curate panel's row-wide edit, which holds several fields at
 * once: the question, the conflict and the failure are said in one set of
 * words wherever a host rewords a finding.
 */
export type EditView = {
	/** The host has been asked what they changed and has not answered yet. */
	asking?: boolean;
	typoLikely: boolean;
	draft?: {
		saving?: boolean;
		refused?: boolean;
		failed?: boolean;
	} | null;
	conflict?: {
		mine: string;
		theirs: string;
		who: string;
	} | null;
	saved?: { kind: WordsChangeKind } | null;
	undoFailed?: boolean;
	restore: () => void;
	save: (kind: WordsChangeKind, reason?: string) => unknown;
	commit: () => void;
	keepMine: () => void;
	keepTheirs: () => void;
	undo: () => unknown;
};

/** The words the prompt offers, and the one the caret rests on. */
export function WordsPrompt({
	edit,
	testId,
}: {
	edit: EditView;
	testId?: string;
}) {
	return (
		<ReasonPrompt
			testId={testId ?? "result-change-prompt"}
			question={<Trans>What did you change?</Trans>}
			focusKey={edit.typoLikely ? "typo" : undefined}
			pending={edit.draft?.saving}
			reasonLabel={
				<Trans>
					Why? One sentence, for the people you work with and anyone who checks
					later.
				</Trans>
			}
			confirmLabel={<Trans>Save</Trans>}
			refused={edit.draft?.refused}
			options={[
				{ key: "typo", label: <Trans>A typo</Trans> },
				{
					key: "clarity",
					label: <Trans>Clearer words, same meaning</Trans>,
				},
				{
					key: "meaning",
					label: <Trans>The meaning</Trans>,
					// A change of meaning is the one a colleague has to be able to
					// read later: the server asks for a sentence, and so does this.
					minimum: MEANING_REASON_MIN,
					needsReason: true,
				},
			]}
			onCancel={edit.restore}
			onConfirm={({ key, reason }) =>
				void edit.save(key as WordsChangeKind, reason)
			}
		/>
	);
}

/** Whether the edit has left something in the meta line to say. */
export const hasAftermath = (edit: EditView): boolean =>
	Boolean(edit.conflict || edit.undoFailed || edit.draft?.failed || edit.saved);

/** What the meta line says after a save, a failure or a conflict. */
export function EditAftermath({ edit }: { edit: EditView }): ReactNode {
	if (edit.conflict)
		return (
			// Whose words in the small print, the words themselves to be read and
			// compared: each line is the control that keeps it.
			<div className={classes.conflict} data-testid="result-conflict-choice">
				<button
					type="button"
					className={classes.wording}
					onClick={edit.keepTheirs}
				>
					<span>{edit.conflict.who}</span>
					<span className={classes.wordingWords}>{edit.conflict.theirs}</span>
				</button>
				<button
					type="button"
					className={classes.wording}
					onClick={edit.keepMine}
				>
					<span>
						<Trans>Yours</Trans>
					</span>
					<span className={classes.wordingWords}>{edit.conflict.mine}</span>
				</button>
			</div>
		);
	if (edit.undoFailed)
		return (
			<p className={classes.notice} data-testid="result-undo-conflict">
				<Trans>
					Someone reworded this after you did. Their words stand. Open it to
					read them
				</Trans>
			</p>
		);
	if (edit.draft?.failed)
		return (
			<p className={classes.notice} data-testid="result-save-failed">
				<Trans>That did not save. Your words are still here.</Trans>{" "}
				{/* Letting go of the words asks again; so does this. */}
				<button
					type="button"
					className={`${classes.control} ${classes.quiet} ${classes.confirm}`}
					onClick={edit.commit}
				>
					<Trans>Try again</Trans>
				</button>
			</p>
		);
	if (edit.saved)
		return (
			<p className={classes.metaLine} data-testid="result-saved">
				{edit.saved.kind === "typo" ? (
					<Trans>Saved as a typo.</Trans>
				) : edit.saved.kind === "clarity" ? (
					<Trans>Saved as clearer words.</Trans>
				) : (
					<Trans>Saved as a change of meaning.</Trans>
				)}{" "}
				<button
					type="button"
					className={`${classes.control} ${classes.quiet} ${classes.confirm}`}
					onClick={() => void edit.undo()}
				>
					<Trans>Undo</Trans>
				</button>
			</p>
		);
	return null;
}
