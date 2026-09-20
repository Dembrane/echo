import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ArrowsLeftRightIcon } from "@phosphor-icons/react";
import { type ReactNode, useRef, useState } from "react";
import type { AnalysisObject } from "@/components/analysis/hooks";
import { ReasonPrompt } from "./ReasonPrompt";
import classes from "./ResultsList.module.css";
import {
	factCheckVerdict,
	fieldWords,
	isEdited,
	primaryFields,
	resultEvidence,
	secondaryField,
} from "./resultContent";
import {
	EditAftermath,
	EditableWords,
	hasAftermath,
	useWordsEdit,
	WordsPrompt,
} from "./resultEditing";
import type { ResultActions } from "./useResultActions";

export type ResultDensity = "curate" | "check";

export type ResultRowProps = {
	item: AnalysisObject;
	density: ResultDensity;
	actions: ResultActions;
	/** Whether this host may change the analysis at all. */
	canEdit: boolean;
	open: boolean;
	onOpen: () => void;
	/** The item, drawn under the row when it is open. */
	children?: ReactNode;
	actorName?: (actorId: string) => string | undefined;
};

const EVIDENCE_SEPARATOR = " · ";

function evidenceWords(quotes: number, conversations: number): string {
	const quoteWords = plural(quotes, { one: "# quote", other: "# quotes" });
	const conversationWords = plural(conversations, {
		one: "# conversation",
		other: "# conversations",
	});
	if (!quotes) return conversationWords;
	if (!conversations) return quoteWords;
	return `${quoteWords}${EVIDENCE_SEPARATOR}${conversationWords}`;
}

/** One phrase per risen row, and only "new" in blue. */
function attentionPhrase(item: AnalysisObject): ReactNode {
	switch (item.attention) {
		case "new":
			return (
				<span className={classes.fresh}>
					<Trans>new</Trans>
				</span>
			);
		case "one_conversation":
			return <Trans>one conversation only</Trans>;
		case "one_quote":
			return <Trans>one quote only</Trans>;
		case "fact_check":
			return <Trans>the fact-check disagrees</Trans>;
		case "reworded":
			return item.attentionActor ? (
				<Trans>{item.attentionActor} reworded this</Trans>
			) : (
				<Trans>Someone reworded this</Trans>
			);
		default:
			return null;
	}
}

/** At most two, in this order: withdrawn, fact-check, edited, combined. */
function stateWords(item: AnalysisObject): ReactNode[] {
	const words: ReactNode[] = [];
	if (item.membershipExcluded) words.push(<Trans key="w">withdrawn</Trans>);
	const verdict = factCheckVerdict(item);
	if (verdict === "false" || verdict === "contested")
		words.push(<Trans key="f">the fact-check disagrees</Trans>);
	if (isEdited(item)) words.push(<Trans key="e">edited</Trans>);
	if (item.type === "deduplicated_argument")
		words.push(<Trans key="c">combined</Trans>);
	return words.slice(0, 2);
}

function stanceWords(item: AnalysisObject): ReactNode {
	const valence = item.payload?.valence;
	if (valence === "positive") return <Trans>for</Trans>;
	if (valence === "negative") return <Trans>against</Trans>;
	return null;
}

/**
 * One finding in a list: one skeleton, four fillings. A primary line in
 * graphite, a secondary line in soft ink, a small meta line the prompt takes
 * over when the host changes the words.
 */
export function ResultRow({
	actions,
	actorName,
	canEdit,
	children,
	density,
	item,
	onOpen,
	open,
}: ResultRowProps) {
	const [holding, setHolding] = useState(false);
	const holdControl = useRef<HTMLButtonElement>(null);
	const edit = useWordsEdit({
		actions: canEdit ? actions : null,
		actorName,
		item,
	});
	const held = actions.isHeld(item.objectId);
	const fields = primaryFields(item.type);
	const second = secondaryField(item.type);
	const secondWords = second ? fieldWords(item, second) : "";
	const evidence = resultEvidence(item);
	const attention = attentionPhrase(item);
	const states = density === "check" ? stateWords(item) : [];
	const clamp = density === "check" ? classes.clamp3 : classes.clamp2;
	const aftermath = hasAftermath(edit);

	const endHold = () => {
		setHolding(false);
		holdControl.current?.focus();
	};

	return (
		<li className={classes.row} data-held={held || undefined}>
			{/* The row opens the item; the words and the controls in it answer
			    for themselves. */}
			{/* biome-ignore lint/a11y/useSemanticElements: a row that holds its own controls cannot be a button */}
			<div
				aria-expanded={open}
				className={classes.rowBody}
				data-testid={`result-row-${item.objectId}`}
				onClick={(event) => {
					if (event.target !== event.currentTarget) return;
					onOpen();
				}}
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
				<div className={classes.rowText}>
					{item.type === "tension" ? (
						<p className={classes.primary}>
							<EditableWords
								clamp={clamp}
								edit={edit}
								field="poleA"
								label={t`One side of this tension`}
								words={fieldWords(item, "poleA")}
							/>
							<ArrowsLeftRightIcon
								aria-hidden
								className={classes.arrows}
								size="0.9em"
							/>
							<EditableWords
								clamp={clamp}
								edit={edit}
								field="poleB"
								label={t`The other side of this tension`}
								words={fieldWords(item, "poleB")}
							/>
						</p>
					) : (
						<p className={classes.primary}>
							<EditableWords
								clamp={clamp}
								edit={edit}
								field={fields[0] ?? "statement"}
								label={t`The words of this finding`}
								words={
									fieldWords(item, fields[0] ?? "statement") ||
									(item.label ?? "")
								}
							/>
						</p>
					)}

					{second && secondWords && (
						<p className={classes.second}>
							<EditableWords
								edit={edit}
								field={second}
								label={t`The second line of this finding`}
								words={secondWords}
							/>
						</p>
					)}
					{item.type.endsWith("argument") && (
						<p className={classes.second}>{stanceWords(item)}</p>
					)}

					{/* The meta line: what the row is made of, or what the host is
					    being asked, in the same place, with a crossfade. */}
					<div className={classes.meta}>
						{edit.asking ? (
							<div className={classes.metaSwap} key="prompt">
								<WordsPrompt
									edit={edit}
									testId={`result-change-prompt-${item.objectId}`}
								/>
							</div>
						) : holding ? (
							<div className={classes.metaSwap} key="hold">
								<ReasonPrompt
									testId={`result-hold-prompt-${item.objectId}`}
									question={<Trans>Why not in this presentation?</Trans>}
									reasonLabel={
										<Trans>
											Why? One sentence, for the people you work with and anyone
											who checks later.
										</Trans>
									}
									confirmLabel={<Trans>Not in this presentation</Trans>}
									options={[
										...actions.heldBackReasons.slice(0, 2).map((reason) => ({
											key: reason,
											label: reason,
											reason,
										})),
										{
											key: "repeats",
											label: t`repeats another finding`,
											reason: t`repeats another finding`,
										},
										{
											key: "off-topic",
											label: t`off topic for this room`,
											reason: t`off topic for this room`,
										},
										{
											key: "other",
											label: t`another reason`,
											needsReason: true,
										},
									].slice(0, 4)}
									onCancel={endHold}
									onConfirm={({ reason }) => {
										actions.holdBack?.(item.objectId, reason ?? "");
										endHold();
									}}
								/>
							</div>
						) : aftermath ? (
							<div className={classes.metaSwap} key="aftermath">
								<EditAftermath edit={edit} />
							</div>
						) : (
							<div className={classes.metaSwap} key="rest">
								<p className={classes.metaLine}>
									{attention && (
										<>
											<span>{attention}</span>
											<span aria-hidden>{EVIDENCE_SEPARATOR}</span>
										</>
									)}
									{evidenceWords(evidence.quotes, evidence.conversations)}
								</p>
								{states.length > 0 && (
									<p
										className={classes.metaState}
										data-testid={`result-state-${item.objectId}`}
									>
										{states.map((word, index) => (
											// biome-ignore lint/suspicious/noArrayIndexKey: two words in a fixed order
											<span key={index}>{word}</span>
										))}
									</p>
								)}
							</div>
						)}
					</div>
				</div>

				<div className={classes.rowControls}>
					{density === "curate" &&
						canEdit &&
						actions.holdBack &&
						(held ? (
							<button
								ref={holdControl}
								type="button"
								className={classes.control}
								data-testid={`result-show-again-${item.objectId}`}
								onClick={() => actions.showAgain?.(item.objectId, "")}
							>
								<Trans>Put back in this presentation</Trans>
							</button>
						) : (
							<button
								ref={holdControl}
								type="button"
								className={classes.control}
								data-testid={`result-hold-back-${item.objectId}`}
								onClick={() => setHolding(true)}
							>
								<Trans>Not in this presentation</Trans>
							</button>
						))}
					<button
						type="button"
						className={classes.control}
						data-testid={`result-open-${item.objectId}`}
						onClick={onOpen}
					>
						{open ? <Trans>Close</Trans> : <Trans>Open</Trans>}
					</button>
				</div>
			</div>
			{/* The item opens under the row, inside the list. */}
			{open && <div className={classes.opened}>{children}</div>}
		</li>
	);
}
