import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { type ReactNode, useEffect, useRef } from "react";
import type { AnalysisObject } from "@/components/analysis/hooks";
import type { ResultFeedbackActions } from "../feedback/useResultFeedback";
import { type EditableField, isMultiline } from "../resultContent";
import { hasAftermath } from "../resultEditing";
import { WordsStep } from "./CurateMeta";
import classes from "./curate.module.css";
import { RowTools } from "./RowTools";
import { openOnClick, type ShapeProps } from "./shape";
import { useHide } from "./useHide";
import { type RowEdit, useRowEdit } from "./useRowEdit";
import type { Selection } from "./useSelection";

export type TableProps = ShapeProps & {
	feedback: ResultFeedbackActions;
	selection: Selection;
};

/** One tick. The header's own is the same control over every row shown. */
function Tick({
	checked,
	indeterminate,
	label,
	onPick,
	testId,
}: {
	checked: boolean;
	indeterminate?: boolean;
	label: string;
	onPick: (shift: boolean) => void;
	testId: string;
}) {
	const box = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (box.current) box.current.indeterminate = Boolean(indeterminate);
	}, [indeterminate]);
	return (
		<input
			ref={box}
			aria-label={label}
			checked={checked}
			className={classes.tick}
			data-testid={testId}
			// The click is what is read, because Shift comes with it and not with
			// the change; Space on the box raises a click of its own.
			onChange={() => {}}
			onClick={(event) => {
				event.stopPropagation();
				onPick(event.shiftKey);
			}}
			type="checkbox"
		/>
	);
}

/**
 * The one table every tab is drawn in: a tick, the finding, what is known
 * about it, and the five tools. Four different kinds of finding read as one
 * list of decisions, which is what a host is actually making here.
 */
export function CurateTable({
	heads,
	ids,
	selection,
	actions,
	testId,
	children,
}: {
	/** The `<th>`s between the tick and the tools. */
	heads: ReactNode;
	/** Every row shown in this tab, in the order it is shown. */
	ids: string[];
	selection: Selection;
	actions: ShapeProps["actions"];
	testId: string;
	children: ReactNode;
}) {
	const state = selection.state(ids);
	const chosen = selection.chosen.filter((id) => ids.includes(id));

	return (
		<div className={classes.tableWrap}>
			{/* One decision about many. It sits over the table rather than inside
			    the head, so no column moves when it appears. */}
			{chosen.length > 0 && (
				<div className={classes.bulk} data-testid="curate-bulk">
					<span className={classes.bulkCount}>
						<Trans>{chosen.length} selected</Trans>
					</span>
					<button
						type="button"
						className={`${classes.control} ${classes.quiet} ${classes.confirm}`}
						data-testid="curate-bulk-hide"
						onClick={() => actions.holdBackMany?.(chosen, true)}
					>
						<Trans>Hide</Trans>
					</button>
					<button
						type="button"
						className={`${classes.control} ${classes.quiet} ${classes.confirm}`}
						data-testid="curate-bulk-show"
						onClick={() => actions.holdBackMany?.(chosen, false)}
					>
						<Trans>Show again</Trans>
					</button>
					<button
						type="button"
						className={`${classes.control} ${classes.quiet} ${classes.confirm}`}
						data-testid="curate-bulk-clear"
						onClick={selection.clear}
					>
						<Trans>Clear</Trans>
					</button>
				</div>
			)}

			<table className={classes.table} data-testid={testId}>
				<thead>
					<tr>
						<th className={classes.pickCell} scope="col">
							<Tick
								checked={state === "all"}
								indeterminate={state === "some"}
								label={t`Select every finding shown`}
								onPick={() => selection.toggleAll(ids)}
								testId="curate-select-all"
							/>
						</th>
						{heads}
						<th className={classes.toolsCell} scope="col">
							<Trans>Tools</Trans>
						</th>
					</tr>
				</thead>
				<tbody>{children}</tbody>
			</table>
		</div>
	);
}

/**
 * One finding's row, and the evidence it opens into.
 *
 * The row opens from anywhere that is not a control of its own, including the
 * words: rewording is the pencil's job now, so a click on a phrase does what a
 * click anywhere else on the row does.
 */
export function CurateRow({
	actions,
	analysisHref,
	canEdit,
	cells,
	columns,
	feedback,
	ids,
	item,
	onOpen,
	open,
	opened,
	selection,
	testId,
}: TableProps & {
	item: AnalysisObject;
	/** The cells between the tick and the tools, given the row's edit mode. */
	cells: (edit: RowEdit) => ReactNode;
	/** What the row opens into: the evidence, and the quiet line under it. */
	opened: (edit: RowEdit) => ReactNode;
	columns: number;
	ids: string[];
	open: boolean;
	onOpen: () => void;
	testId: string;
}) {
	const hide = useHide({ actions, objectId: item.objectId });
	const edit = useRowEdit({ actions: canEdit ? actions : null, item });

	return (
		<>
			{/* The row is not a button: a host reaches the finding through the
			    controls it holds, which are all in the tab order. */}
			<tr
				aria-expanded={open}
				className={classes.bodyRow}
				data-held={hide.held || undefined}
				data-testid={testId}
				onClick={(event) => openOnClick(event, onOpen)}
				onKeyDown={(event) => {
					// Escape leaves edit mode from wherever the caret is in the row.
					if (event.key === "Escape" && edit.on) {
						event.stopPropagation();
						edit.cancel();
					}
				}}
			>
				<td className={classes.pickCell}>
					<Tick
						checked={selection.has(item.objectId)}
						label={t`Select this finding`}
						onPick={(shift) => selection.toggle(item.objectId, ids, shift)}
						testId={`curate-pick-${item.objectId}`}
					/>
				</td>
				{cells(edit)}
				<td className={classes.toolsCell}>
					<RowTools
						analysisHref={analysisHref}
						edit={edit}
						feedback={feedback}
						hide={hide}
						item={item}
					/>
				</td>
			</tr>

			{/* ── The change-kind step ──────────────────────────────────────────
			    "What did you change?" after a save, and what came of it. It is
			    not in the wireframes; the audit trail is what keeps it. Deleting
			    this one block and the `asking` gate in `useRowEdit.commit` takes
			    the question out and leaves everything else standing. */}
			{(edit.asking || hasAftermath(edit.prompt)) && (
				<tr>
					<td className={classes.stepCell} colSpan={columns}>
						<WordsStep edit={edit.prompt} objectId={item.objectId} />
					</td>
				</tr>
			)}

			{open && (
				<tr>
					<td className={classes.openedCell} colSpan={columns}>
						{opened(edit)}
					</td>
				</tr>
			)}
		</>
	);
}

/**
 * The words of one field, read or written in the same place, in the same
 * type. Outside edit mode they are simply the words: nothing to click, so
 * clicking them opens the row like the rest of it.
 */
export function RowWords({
	className,
	edit,
	field,
	label,
	words,
}: {
	edit: RowEdit;
	field: EditableField;
	words: string;
	label: string;
	className?: string;
}) {
	const box = useRef<HTMLTextAreaElement>(null);
	// The caret lands in the first field of the row, and nowhere else moves.
	const first = edit.fields[0] === field;

	useEffect(() => {
		if (!edit.on || !first) return;
		const node = box.current;
		if (!node) return;
		node.focus();
		node.setSelectionRange(node.value.length, node.value.length);
	}, [edit.on, first]);

	if (!edit.on) return <span className={className}>{words}</span>;

	return (
		<textarea
			ref={box}
			aria-label={label}
			className={`${classes.words} ${className ?? ""}`}
			data-edit=""
			data-testid={`curate-words-${field}`}
			onChange={(event) => edit.set(field, event.currentTarget.value)}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.stopPropagation();
					event.preventDefault();
					edit.cancel();
					return;
				}
				if (event.key !== "Enter") return;
				// Where a sentence is expected, Enter makes a line and
				// Cmd/Ctrl+Enter is the one that saves.
				if (isMultiline(field) && !(event.metaKey || event.ctrlKey)) return;
				event.preventDefault();
				edit.commit();
			}}
			rows={isMultiline(field) ? 2 : 1}
			value={edit.text(field)}
		/>
	);
}
