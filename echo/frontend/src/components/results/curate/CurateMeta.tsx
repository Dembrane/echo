import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Tooltip } from "@mantine/core";
import { EyeIcon, EyeSlashIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { AnalysisObject } from "@/components/analysis/hooks";
import { ReasonPrompt } from "../ReasonPrompt";
import {
	EditAftermath,
	hasAftermath,
	type WordsEdit,
	WordsPrompt,
} from "../resultEditing";
import type { ResultActions } from "../useResultActions";
import classes from "./curate.module.css";
import type { Hide } from "./useHide";

/**
 * What the host is being asked about the words they just changed, and what
 * came of it. It opens under the finding it belongs to rather than taking a
 * line over, because these shapes have no line to spare: a popcorn row is one
 * line, a table cell is a cell.
 */
export function WordsStep({
	edit,
	objectId,
}: {
	edit: WordsEdit;
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
 * The eye. Hiding is one click and no question; restoring is the same click
 * back, and lives on the same glyph in the same place, always.
 */
export function HideControl({ hide }: { hide: Hide }) {
	if (!hide.canHide) return null;
	return hide.held ? (
		<Tooltip label={t`Restore`}>
			<button
				ref={hide.control}
				type="button"
				aria-label={t`Restore`}
				className={`${classes.control} ${classes.icon}`}
				data-testid={`curate-restore-${hide.objectId}`}
				onClick={hide.show}
			>
				<EyeIcon aria-hidden size={16} />
			</button>
		</Tooltip>
	) : (
		<Tooltip label={t`Hide`}>
			<button
				ref={hide.control}
				type="button"
				aria-label={t`Hide`}
				className={`${classes.control} ${classes.icon}`}
				data-testid={`curate-hide-${hide.objectId}`}
				onClick={hide.hide}
			>
				<EyeSlashIcon aria-hidden size={16} />
			</button>
		</Tooltip>
	);
}

/**
 * The line under a finding: what it is made of, or that it is not in this
 * presentation and the two ways out of that. A hidden finding says so in
 * words, because dimmed words alone say nothing; the reason is the host's to
 * add, never a toll on the way through.
 */
export function QuietLine({
	actions,
	hide,
	lead,
	objectId,
}: {
	actions: ResultActions;
	hide: Hide;
	/** What this line says when nothing has been hidden. */
	lead?: ReactNode;
	objectId: string;
}) {
	if (hide.asking)
		return (
			<div className={`${classes.step} ${classes.quietLine}`}>
				<ReasonPrompt
					testId={`curate-reason-${objectId}`}
					question={<Trans>Why not in this presentation?</Trans>}
					reasonLabel={
						<Trans>
							One sentence, for the people you work with and anyone who checks
							later.
						</Trans>
					}
					confirmLabel={<Trans>Save</Trans>}
					options={[
						// The last reasons this browser used, each said once, then the
						// way to say something else.
						...[
							...actions.heldBackReasons,
							t`repeats another finding`,
							t`off topic for this room`,
						]
							.filter((reason, index, all) => all.indexOf(reason) === index)
							.slice(0, 3)
							.map((reason) => ({ key: reason, label: reason, reason })),
						{
							key: "other",
							label: t`another reason`,
							needsReason: true,
						},
					]}
					onCancel={hide.stopAsking}
					onConfirm={({ reason }) => hide.saveReason(reason ?? "")}
				/>
			</div>
		);

	if (hide.held)
		return (
			<p className={classes.quietLine} data-testid={`curate-held-${objectId}`}>
				<span>
					<Trans>hidden from this presentation</Trans>
				</span>
				{hide.undoable && (
					<>
						<span aria-hidden className={classes.dot}>
							·
						</span>
						<button
							type="button"
							className={`${classes.control} ${classes.quiet} ${classes.confirm}`}
							data-testid={`curate-undo-${objectId}`}
							onClick={hide.show}
						>
							<Trans>Undo</Trans>
						</button>
					</>
				)}
				<span aria-hidden className={classes.dot}>
					·
				</span>
				{hide.reason ? (
					<span>{hide.reason}</span>
				) : (
					<button
						type="button"
						className={`${classes.control} ${classes.quiet} ${classes.confirm}`}
						data-testid={`curate-add-reason-${objectId}`}
						onClick={hide.askReason}
					>
						<Trans>add a reason</Trans>
					</button>
				)}
			</p>
		);

	if (!lead) return null;
	return <p className={classes.quietLine}>{lead}</p>;
}
