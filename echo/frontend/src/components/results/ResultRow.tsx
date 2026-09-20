import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Tooltip } from "@mantine/core";
import {
	ArrowsLeftRightIcon,
	CaretDownIcon,
	CaretUpIcon,
	EyeIcon,
	EyeSlashIcon,
} from "@phosphor-icons/react";
import { type ReactNode, useRef, useState } from "react";
import type { AnalysisObject } from "@/components/analysis/hooks";
import { ReasonPrompt } from "./ReasonPrompt";
import { rungWord } from "./ResultItem";
import classes from "./ResultsList.module.css";
import {
	evidenceWords,
	factCheckVerdict,
	fieldWords,
	isEdited,
	namesOneConversation,
	primaryFields,
	resultEvidence,
	resultFields,
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

/**
 * One phrase per risen row, and only "new" in blue. `named` is a row whose
 * evidence already reads "1 quote from Marloes": the sentence has said how
 * thin it is, so the phrase says nothing more. The row keeps its place.
 */
function attentionPhrase(item: AnalysisObject, named: boolean): ReactNode {
	switch (item.attention) {
		case "new":
			return (
				<span className={classes.fresh}>
					<Trans>new</Trans>
				</span>
			);
		case "one_conversation":
			return named ? null : <Trans>one conversation only</Trans>;
		case "one_quote":
			return named ? null : <Trans>one quote only</Trans>;
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
	// Said once: a row that rose for its fact-check already leads with it.
	if (
		(verdict === "false" || verdict === "contested") &&
		item.attention !== "fact_check"
	)
		words.push(<Trans key="f">the fact-check disagrees</Trans>);
	if (isEdited(item)) words.push(<Trans key="e">edited</Trans>);
	if (item.type === "deduplicated_argument")
		words.push(<Trans key="c">combined</Trans>);
	return words.slice(0, 2);
}

/** Anything in the row that answers for itself, so a click on it is its own. */
const OWN_CONTROLS = "button, a, input, textarea, select, label, [data-step]";

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
	// The meta line fades when a step takes it over and when it comes back,
	// never when the list first draws.
	const stepped = useRef(false);
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
	// The name is a host's: an audience payload carries none.
	const named = namesOneConversation(evidence, item.conversationName);
	const attention = attentionPhrase(item, named);
	const states = density === "check" ? stateWords(item) : [];
	const clamp = density === "check" ? classes.clamp3 : classes.clamp2;
	const aftermath = hasAftermath(edit);
	// Holding back is Present's, and a host's: everywhere else the row has one
	// control, and a narrow list leaves it beside the words.
	const holdable = density === "curate" && canEdit && Boolean(actions.holdBack);
	const rung =
		item.type === "stakeholder" ? rungWord(resultFields(item).rung) : null;
	if (edit.asking || holding || aftermath) stepped.current = true;
	const stepClass = `${classes.metaSwap} ${classes.step}`;

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
				data-solo={holdable ? undefined : ""}
				data-testid={`result-row-${item.objectId}`}
				onClick={(event) => {
					// The row opens the item from anywhere that is not a control of
					// its own: the words, a step in the meta line, the buttons.
					const own = (event.target as Element).closest(OWN_CONTROLS);
					if (
						own &&
						own !== event.currentTarget &&
						event.currentTarget.contains(own)
					)
						return;
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
							{/* The arrows travel with the second pole when the line wraps. */}
							<span className={classes.pole}>
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
							</span>
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
							{rung && <span className={classes.tag}>{rung}</span>}
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
				</div>

				{/* The meta line: what the row is made of, or what the host is
				    being asked, in the same place, with a crossfade. It runs under
				    the words and the controls both. */}
				<div className={classes.meta}>
					{edit.asking ? (
						<div className={stepClass} data-step="" key="prompt">
							<WordsPrompt
								edit={edit}
								testId={`result-change-prompt-${item.objectId}`}
							/>
						</div>
					) : holding ? (
						<div className={stepClass} data-step="" key="hold">
							<ReasonPrompt
								testId={`result-hold-prompt-${item.objectId}`}
								question={<Trans>Why not in this presentation?</Trans>}
								// The question above it already asks why.
								reasonLabel={
									<Trans>
										One sentence, for the people you work with and anyone who
										checks later.
									</Trans>
								}
								confirmLabel={<Trans>Hide</Trans>}
								options={[
									// Three suggestions, the last reason used first, each said
									// once; then the way to say something else.
									...[
										...actions.heldBackReasons,
										t`repeats another finding`,
										t`off topic for this room`,
									]
										.filter(
											(reason, index, all) => all.indexOf(reason) === index,
										)
										.slice(0, 3)
										.map((reason) => ({ key: reason, label: reason, reason })),
									{
										key: "other",
										label: t`another reason`,
										needsReason: true,
									},
								]}
								onCancel={endHold}
								onConfirm={({ reason }) => {
									actions.holdBack?.(item.objectId, reason ?? "");
									endHold();
								}}
							/>
						</div>
					) : aftermath ? (
						<div className={stepClass} data-step="" key="aftermath">
							<EditAftermath edit={edit} />
						</div>
					) : (
						<div
							className={`${stepped.current ? stepClass : classes.metaSwap} ${classes.rest}`}
							key="rest"
						>
							<p className={classes.metaLine}>
								{attention && (
									<>
										<span>{attention}</span>
										{evidenceWords(evidence, item.conversationName) && (
											<span aria-hidden>{EVIDENCE_SEPARATOR}</span>
										)}
									</>
								)}
								{evidenceWords(evidence, item.conversationName)}
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

				{/* The row's actions, in the conversations table's manner: icons at
				    the right edge, the words they stand for in the tooltip and the
				    label, faint until a hand comes near. */}
				<div className={classes.rowControls}>
					{holdable &&
						(held ? (
							<Tooltip label={t`Restore`}>
								<button
									ref={holdControl}
									type="button"
									aria-label={t`Restore`}
									className={`${classes.control} ${classes.icon}`}
									data-testid={`result-show-again-${item.objectId}`}
									onClick={() => actions.showAgain?.(item.objectId, "")}
								>
									<EyeIcon aria-hidden size={16} />
								</button>
							</Tooltip>
						) : (
							<Tooltip label={t`Hide`}>
								<button
									ref={holdControl}
									type="button"
									aria-label={t`Hide`}
									className={`${classes.control} ${classes.icon}`}
									data-testid={`result-hold-back-${item.objectId}`}
									onClick={() => setHolding(true)}
								>
									<EyeSlashIcon aria-hidden size={16} />
								</button>
							</Tooltip>
						))}
					<Tooltip label={open ? t`Close` : t`Open`}>
						<button
							type="button"
							aria-label={open ? t`Close` : t`Open`}
							className={`${classes.control} ${classes.icon}`}
							data-testid={`result-open-${item.objectId}`}
							onClick={onOpen}
						>
							{open ? (
								<CaretUpIcon aria-hidden size={16} />
							) : (
								<CaretDownIcon aria-hidden size={16} />
							)}
						</button>
					</Tooltip>
				</div>
			</div>
			{/* The item opens under the row, inside the list. */}
			{open && <div className={classes.opened}>{children}</div>}
		</li>
	);
}
