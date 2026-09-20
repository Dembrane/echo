import { t } from "@lingui/core/macro";
import type { AnalysisObject } from "@/components/analysis/hooks";
import {
	conversationWords,
	evidenceGroups,
	fieldWords,
} from "../resultContent";
import { EditableWords, useWordsEdit } from "../resultEditing";
import {
	attentionPhrase,
	HideControl,
	QuietLine,
	WordsStep,
} from "./CurateMeta";
import { CurateOpen } from "./CurateOpen";
import classes from "./curate.module.css";
import { openOnClick, type ShapeProps } from "./shape";
import { useHide } from "./useHide";

/**
 * Forty at rest, then the whole set. A popcorn tab is a culling job: the host
 * reads fast down two columns and takes phrases out, so the page holds enough
 * to get a rhythm going without asking for 146 rows nobody scrolls.
 */
export const POPCORN_AT_REST = 40;

function PopcornRow({
	actions,
	analysisHref,
	canEdit,
	item,
	onOpen,
	open,
	projectId,
}: ShapeProps & { item: AnalysisObject; open: boolean; onOpen: () => void }) {
	const hide = useHide({ actions, objectId: item.objectId });
	const edit = useWordsEdit({ actions: canEdit ? actions : null, item });
	const groups = evidenceGroups(item);
	const where = conversationWords(item, groups[0]);
	const phrase = fieldWords(item, "phrase") || (item.label ?? "");
	// A popcorn is one phrase from one conversation: "one quote only" would be
	// true of every row and so is said on none of them.
	const attention = attentionPhrase(item, { thin: false });

	return (
		<li className={classes.pop} data-held={hide.held || undefined}>
			{/* biome-ignore lint/a11y/useSemanticElements: a row that holds its own controls cannot be a button */}
			<div
				aria-expanded={open}
				className={classes.popBody}
				data-testid={`curate-pop-${item.objectId}`}
				onClick={(event) => openOnClick(event, onOpen)}
				onKeyDown={(event) => {
					if (event.target !== event.currentTarget) return;
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						onOpen();
					}
				}}
				role="button"
				tabIndex={0}
			>
				<p className={classes.popWords}>
					<EditableWords
						edit={edit}
						field="phrase"
						label={t`The words of this finding`}
						words={phrase}
					/>
					{where && <span className={classes.popWhere}>{where}</span>}
				</p>
				<HideControl hide={hide} />
			</div>
			<WordsStep edit={edit} objectId={item.objectId} />
			<QuietLine
				actions={actions}
				hide={hide}
				lead={attention}
				objectId={item.objectId}
			/>
			{/* Opened, a popcorn shows the one thing the row cannot: the sentence
			    the phrase was cut from, with the phrase marked inside it. */}
			{open && (
				<CurateOpen
					actions={actions}
					analysisHref={analysisHref}
					canEdit={canEdit}
					item={item}
					projectId={projectId}
					quotes={groups.flatMap((group) =>
						group.quotes.map((quote) => ({
							cut: phrase,
							text: quote,
							where: conversationWords(item, group),
						})),
					)}
				/>
			)}
		</li>
	);
}

/**
 * The popcorn tab: one line per phrase, the conversation beside it, two
 * columns where the panel is wide enough to carry them. No meta line under
 * every row and no caret at its end — the phrase is its own quote, and the
 * only thing the row needs a hand for is taking it out.
 */
export function PopcornTab({
	items,
	openObjectId,
	onOpen,
	...shape
}: ShapeProps & {
	items: AnalysisObject[];
	openObjectId: string | null;
	onOpen: (item: AnalysisObject) => void;
}) {
	return (
		<ul className={classes.pops} data-testid="curate-popcorn">
			{items.map((item) => (
				<PopcornRow
					{...shape}
					item={item}
					key={item.objectId}
					onOpen={() => onOpen(item)}
					open={openObjectId === item.objectId}
				/>
			))}
		</ul>
	);
}
