import { Trans } from "@lingui/react/macro";
import { type ReactNode, useRef, useState } from "react";
import {
	type AnalysisObject,
	useSetAnalysisMembership,
} from "@/components/analysis/hooks";
import { I18nLink } from "@/components/common/i18nLink";
import { ReasonPrompt } from "../ReasonPrompt";
import { ResultItem } from "../ResultItem";
import {
	conversationWords,
	cutFrom,
	type EvidenceGroup,
	evidenceGroups,
	WITHDRAW_REASON_MIN,
} from "../resultContent";
import type { ResultActions } from "../useResultActions";
import classes from "./curate.module.css";

/** A quote to read, and where it came from. */
export type CurateQuote = {
	text: string;
	/** The conversation's name, or nothing where the payload carries none. */
	where: string;
	/** The phrase this quote was cut from, marked inside the sentence. */
	cut?: string;
};

/**
 * The quotes of a finding, in the order the payload carries them, each with
 * the conversation it came from. Hosts see names; a room never does, and this
 * panel is only ever a host's.
 */
export function curateQuotes(
	item: AnalysisObject,
	groups: EvidenceGroup[] = evidenceGroups(item),
): CurateQuote[] {
	return groups.flatMap((group) =>
		group.quotes.map((quote) => ({
			text: quote,
			where: conversationWords(item, group),
		})),
	);
}

/**
 * One quote, clamped at three lines with the way to read the rest in its
 * place. A phrase the quote was cut from is marked inside it by weight, which
 * is the one emphasis this panel has left: colour is spoken for.
 */
export function Quote({ quote }: { quote: CurateQuote }) {
	const [all, setAll] = useState(false);
	const piece = quote.cut ? cutFrom(quote.text, quote.cut) : null;
	return (
		<li className={classes.quote}>
			<p
				className={classes.quoteText}
				data-open={all || undefined}
				data-testid="curate-quote"
			>
				{piece ? (
					<>
						{piece.before}
						<span className={classes.cut}>{piece.match}</span>
						{piece.after}
					</>
				) : (
					quote.text
				)}
			</p>
			<p className={classes.quoteWhere}>
				{quote.where}
				{!all && quote.text.length > 180 && (
					<>
						{quote.where ? " · " : ""}
						<button
							type="button"
							className={`${classes.control} ${classes.quiet} ${classes.confirm}`}
							onClick={() => setAll(true)}
						>
							<Trans>more</Trans>
						</button>
					</>
				)}
			</p>
		</li>
	);
}

export type CurateActionsProps = {
	item: AnalysisObject;
	projectId: string;
	analysisHref: string;
	canEdit: boolean;
	actions: ResultActions;
	className?: string;
};

/**
 * The one quiet line of what a host can do with a finding here, and the
 * workbench that opens under it.
 *
 * Not the stage card. The card is what the room sees, and the room's own
 * screen is in the preview above this panel: drawing it again under the row
 * says the same thing a third time. The card and the history are still a
 * click away, behind "History / details", which opens the workbench in place,
 * so `ResultItem` stays what Analysis and the map open too.
 */
export function CurateActions({
	actions,
	analysisHref,
	canEdit,
	className,
	item,
	projectId,
}: CurateActionsProps) {
	const [withdrawing, setWithdrawing] = useState(false);
	const [details, setDetails] = useState(false);
	const [refused, setRefused] = useState(false);
	const withdrawControl = useRef<HTMLButtonElement>(null);
	const membership = useSetAnalysisMembership(projectId, item.objectId);
	const withdrawn = Boolean(item.membershipExcluded);

	const endWithdraw = () => {
		setWithdrawing(false);
		setRefused(false);
		window.setTimeout(() => withdrawControl.current?.focus(), 0);
	};

	return (
		<div
			className={[classes.actionsBlock, className].filter(Boolean).join(" ")}
		>
			{/* One quiet line, in the small print: the heavy one, the way to the
			    whole picture, and the way to everything else. */}
			{withdrawing ? (
				<div className={`${classes.step} ${classes.actionsLine}`}>
					<ReasonPrompt
						testId={`curate-withdraw-${item.objectId}`}
						question={<Trans>Withdraw this from the analysis?</Trans>}
						reasonLabel={
							<Trans>
								Why? One sentence, for the people you work with and anyone who
								checks later.
							</Trans>
						}
						confirmLabel={<Trans>Withdraw</Trans>}
						pending={membership.isPending}
						refused={refused}
						options={[
							{
								key: "withdraw",
								label: <Trans>Withdraw from the analysis</Trans>,
								minimum: WITHDRAW_REASON_MIN,
								needsReason: true,
							},
						]}
						onCancel={endWithdraw}
						onConfirm={({ reason }) =>
							membership.mutate(
								{
									change_kind: "withdraw",
									excluded: true,
									expected_revision_id: item.revisionId,
									reason: reason ?? "",
								},
								{
									onError: (error: unknown) => {
										// A reason the server will not take is asked for again,
										// in the line the host is reading.
										if ((error as { status?: number })?.status === 422)
											setRefused(true);
									},
									onSuccess: endWithdraw,
								},
							)
						}
					/>
				</div>
			) : (
				<div className={classes.actionsLine}>
					{canEdit &&
						(withdrawn ? (
							<span>
								<Trans>Withdrawn from the analysis</Trans>
							</span>
						) : (
							<button
								ref={withdrawControl}
								type="button"
								className={`${classes.control} ${classes.quiet}`}
								data-testid={`curate-withdraw-open-${item.objectId}`}
								onClick={() => setWithdrawing(true)}
							>
								<Trans>Withdraw from the analysis</Trans>
							</button>
						))}
					<I18nLink
						className={`${classes.control} ${classes.quiet}`}
						to={analysisHref}
					>
						<Trans>Open in Analysis</Trans>
					</I18nLink>
					<button
						type="button"
						className={`${classes.control} ${classes.quiet}`}
						aria-expanded={details}
						data-testid={`curate-details-${item.objectId}`}
						onClick={() => setDetails((open) => !open)}
					>
						<Trans>History / details</Trans>
					</button>
				</div>
			)}

			{/* One click deeper: the card the room gets and the workbench beside
			    it, which is what Analysis and the map open too. */}
			{details && (
				<div className={classes.workbench}>
					<ResultItem
						analysisHref={analysisHref}
						canEdit={canEdit}
						item={item}
						onClose={() => setDetails(false)}
						onEditWords={actions}
						projectId={projectId}
					/>
				</div>
			)}
		</div>
	);
}

/**
 * A finding opened in a list: what the row lacks, which is the evidence, and
 * under it the quiet line of what can be done about it. The shapes that carry
 * their evidence on the face of them — a tension's card — use
 * `CurateActions` on its own instead.
 */
export function CurateOpen({
	quotes,
	verdict,
	...actions
}: CurateActionsProps & {
	/** The quotes to read. The finding's own, where the shape names none. */
	quotes?: CurateQuote[];
	/** Under the quotes: the fact-check's own sentence, where there is one. */
	verdict?: ReactNode;
}) {
	const shown = quotes ?? curateQuotes(actions.item);
	return (
		<div
			className={classes.opened}
			data-testid={`curate-open-${actions.item.objectId}`}
		>
			{shown.length > 0 ? (
				<ul className={classes.quotes}>
					{shown.map((quote, index) => (
						// Quotes repeat across findings; position keeps them apart.
						// biome-ignore lint/suspicious/noArrayIndexKey: quotes have no id
						<Quote key={index} quote={quote} />
					))}
				</ul>
			) : (
				<p className={classes.empty}>
					<Trans>No quotes were kept with this finding.</Trans>
				</p>
			)}
			{verdict && <p className={classes.verdict}>{verdict}</p>}
			<CurateActions {...actions} />
		</div>
	);
}
