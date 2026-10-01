import { Trans } from "@lingui/react/macro";
import type { ReactNode } from "react";
import type { AnalysisObject } from "@/components/analysis/hooks";
import {
	EditAftermath,
	type EditView,
	hasAftermath,
	WordsPrompt,
} from "../resultEditing";
import classes from "./curate.module.css";

/**
 * What the host is being asked about the words they just changed, and what
 * came of it. It opens under the row it belongs to rather than taking a line
 * over, because these shapes have no line to spare: a row is a row.
 */
export function WordsStep({
	edit,
	objectId,
}: {
	edit: EditView;
	objectId: string;
}): ReactNode {
	if (edit.asking)
		return (
			<div className={`${classes.step} ${classes.quietLine}`}>
				<WordsPrompt edit={edit} testId={`curate-change-${objectId}`} />
			</div>
		);
	if (hasAftermath(edit))
		return (
			<div className={`${classes.step} ${classes.quietLine}`}>
				<EditAftermath edit={edit} />
			</div>
		);
	return null;
}

/**
 * One phrase per finding that rose, and only "new" in blue. Popcorn drops
 * "one quote only" and "one conversation only": a popcorn is one phrase from
 * one conversation by definition, and a line saying so on every row says
 * nothing at all.
 */
export function attentionPhrase(
	item: AnalysisObject,
	{ thin = true }: { thin?: boolean } = {},
): ReactNode {
	switch (item.attention) {
		case "new":
			return (
				<span className={classes.fresh}>
					<Trans>new</Trans>
				</span>
			);
		case "one_conversation":
			return thin ? <Trans>one conversation only</Trans> : null;
		case "one_quote":
			return thin ? <Trans>one quote only</Trans> : null;
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

/**
 * The attention word over the finding's own words: a small line in soft ink,
 * leading the first column rather than sitting in one of its own.
 */
export function AttentionLead({
	item,
	thin = true,
}: {
	item: AnalysisObject;
	/** Whether "one quote only" is worth saying: not where nearly every row is. */
	thin?: boolean;
}): ReactNode {
	const said = attentionPhrase(item, { thin });
	if (!said) return null;
	return <span className={classes.attention}>{said}</span>;
}
