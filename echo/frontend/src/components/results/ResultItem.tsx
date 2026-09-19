import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ArrowsLeftRightIcon, QuotesIcon } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
	type AnalysisObject,
	type AnalysisRevision,
	useAnalysisObjectHistory,
	useRollbackAnalysisObject,
	useSetAnalysisMembership,
} from "@/components/analysis/hooks";
import { I18nLink } from "@/components/common/i18nLink";
import classes from "./ResultItem.module.css";
import {
	type ChangeKind,
	changeKindOf,
	isEdited,
	primaryText,
	QUOTE_LIMIT,
	type ResultEvidence,
	resultEvidence,
	resultFields,
	resultQuotes,
	revisionWording,
	sizeStep,
} from "./resultContent";

/** What the fact-check says about an argument, where a presentation shows it. */
export type ResultFactCheck = {
	verdict: string;
	justification?: string | null;
};

export type ResultStageProps = {
	/** The finding. `payload` where the reader has it, `detail` on the map. */
	item: Pick<AnalysisObject, "type"> & Partial<AnalysisObject>;
	/**
	 * The quotes to read. Defaults to what the object carries, which for a
	 * sanitized audience payload is nothing at all.
	 */
	quotes?: string[];
	/** Overrides the count the object carries, where the caller knows better. */
	evidence?: ResultEvidence;
	factCheck?: ResultFactCheck | null;
	className?: string;
};

const stanceWord = (fields: Record<string, unknown>): ReactNode => {
	const valence = fields.valence;
	if (valence === "positive") return <Trans>For</Trans>;
	if (valence === "negative") return <Trans>Against</Trans>;
	return null;
};

const rungWord = (rung: unknown): ReactNode => {
	if (rung === "named") return <Trans>Named by participants</Trans>;
	if (rung === "inferred") return <Trans>Inferred</Trans>;
	return null;
};

function evidenceLine({ conversations, quotes }: ResultEvidence): string {
	const quoteWords = plural(quotes, { one: "# quote", other: "# quotes" });
	const conversationWords = plural(conversations, {
		one: "# conversation",
		other: "# conversations",
	});
	if (!quotes) return conversationWords;
	if (!conversations) return quoteWords;
	return `${quoteWords} · ${conversationWords}`;
}

/**
 * The stage card: pixel for pixel what a room gets. The finding in its kind's
 * shape, three type sizes by length and never truncated, at most three quotes
 * of three lines each, unattributed, and the evidence count.
 */
export function ResultStage({
	className,
	evidence,
	factCheck,
	item,
	quotes,
}: ResultStageProps) {
	const fields = resultFields(item);
	const fallback = item.label ?? "";
	const primary = primaryText(item.type, fields, fallback);
	// A tension is read as two poles, each in half the card: the longer pole
	// sets the size, against half the measure.
	const step =
		item.type === "tension" && (fields.poleA || fields.poleB)
			? sizeStep(
					[String(fields.poleA ?? ""), String(fields.poleB ?? "")].reduce(
						(longer, pole) => (pole.length > longer.length ? pole : longer),
					),
					2,
				)
			: sizeStep(primary);
	const sizeClass = classes[`size${step}`];
	const shown = (quotes ?? resultQuotes(item)).slice(0, QUOTE_LIMIT);
	const counted = evidence ?? resultEvidence(item);
	const edited = isEdited(item);
	const stance = item.type.endsWith("argument") ? stanceWord(fields) : null;
	const rung =
		item.type === "stakeholder" && fields.rung !== "voiced"
			? rungWord(fields.rung)
			: null;

	return (
		<article
			className={[classes.stage, className].filter(Boolean).join(" ")}
			data-testid="result-stage"
		>
			<div className={classes.card}>
				<div className={classes.head}>
					{item.type === "tension" ? (
						<p className={`${classes.finding} ${sizeClass} ${classes.poles}`}>
							<span>{String(fields.poleA ?? "")}</span>
							{/* Sized in em, so the arrows keep step with the words. */}
							<ArrowsLeftRightIcon
								aria-hidden
								className={classes.arrows}
								size="0.8em"
							/>
							<span>{String(fields.poleB ?? "")}</span>
						</p>
					) : (
						<p className={`${classes.finding} ${sizeClass}`}>{primary}</p>
					)}

					{item.type === "tension" && Boolean(fields.knot) && (
						<p className={classes.second}>{String(fields.knot)}</p>
					)}
					{item.type === "tension" && Boolean(fields.toResolve) && (
						<p className={classes.stance}>
							<Trans>To resolve</Trans>: {String(fields.toResolve)}
						</p>
					)}
					{item.type === "stakeholder" && Boolean(fields.role) && (
						<p className={classes.second}>{String(fields.role)}</p>
					)}
					{item.type === "stakeholder" && Boolean(fields.stake) && (
						<p className={classes.stance}>{String(fields.stake)}</p>
					)}
					{rung && <p className={classes.tag}>{rung}</p>}
					{stance && <p className={classes.stance}>{stance}</p>}
					{/* The mark belongs to the finding's words and sits with them, above
					    the seam: nothing under it was ever edited. The word alone; the
					    pencil glyph is for a pop or a map node, where a word will not
					    fit. */}
					{edited && (
						<p className={classes.edited} data-testid="result-edited">
							<Trans>edited</Trans>
						</p>
					)}
				</div>

				{/* What people said, and how much of it there is: one group. */}
				<div className={classes.evidence}>
					{shown.length > 0 && (
						<div className={classes.quotes} data-testid="result-quotes">
							{shown.map((quote, index) => (
								<blockquote
									// Quotes repeat across findings; position keeps them apart.
									// biome-ignore lint/suspicious/noArrayIndexKey: quotes have no id
									key={index}
									className={classes.quote}
								>
									<QuotesIcon
										aria-hidden
										className={classes.mark}
										weight="fill"
									/>
									<span className={classes.quoteText}>{quote}</span>
								</blockquote>
							))}
						</div>
					)}

					<p className={classes.meta}>{evidenceLine(counted)}</p>
				</div>

				{factCheck && (
					<div className={classes.verdict}>
						<p className={classes.verdictWord}>{factCheck.verdict}</p>
						{factCheck.justification && (
							<p className={classes.line}>{factCheck.justification}</p>
						)}
					</div>
				)}
			</div>
		</article>
	);
}

const changeKindWord = (kind: ChangeKind | null): ReactNode => {
	switch (kind) {
		case "typo":
			return <Trans>A typo</Trans>;
		case "clarity":
			return <Trans>Clearer words, same meaning</Trans>;
		case "meaning":
			return <Trans>The meaning</Trans>;
		case "withdraw":
			return <Trans>Withdrawn from the analysis</Trans>;
		case "restore":
			return <Trans>Restored to the analysis</Trans>;
		case "rollback":
			return <Trans>An earlier wording restored</Trans>;
		default:
			return <Trans>Kind of change not recorded</Trans>;
	}
};

function whenWord(value?: string | null): string {
	if (!value) return t`Time not recorded`;
	const at = new Date(value);
	return Number.isNaN(at.getTime())
		? t`Time not recorded`
		: new Intl.DateTimeFormat(undefined, {
				dateStyle: "medium",
				timeStyle: "short",
			}).format(at);
}

/** A step that asks for a reason and will not send without one. */
function ReasonStep({
	label,
	confirmLabel,
	pending,
	onCancel,
	onConfirm,
	testId,
}: {
	label: ReactNode;
	confirmLabel: ReactNode;
	pending?: boolean;
	onCancel: () => void;
	onConfirm: (reason: string) => void;
	testId: string;
}) {
	const [reason, setReason] = useState("");
	const [tooShort, setTooShort] = useState(false);
	const field = useRef<HTMLTextAreaElement>(null);
	// The host asked for this step, so the caret is already in the field.
	useEffect(() => {
		field.current?.focus();
	}, []);

	const send = () => {
		const written = reason.trim();
		// The server enforces the real minimum; this only keeps a host from
		// sending a reason nobody could read later.
		if (written.length < 4) {
			setTooShort(true);
			field.current?.focus();
			return;
		}
		onConfirm(written);
	};

	return (
		<div className={classes.reasonStep} data-testid={testId}>
			<div className={classes.reasonInner}>
				{/* Labelled above, never as a placeholder. */}
				<label className={classes.reasonLabel} htmlFor={`${testId}-field`}>
					{label}
				</label>
				<textarea
					ref={field}
					id={`${testId}-field`}
					className={classes.reasonField}
					rows={2}
					value={reason}
					aria-describedby={tooShort ? `${testId}-note` : undefined}
					onChange={(event) => {
						setReason(event.currentTarget.value);
						setTooShort(false);
					}}
					onKeyDown={(event) => {
						// Escape backs out one step, and only one.
						if (event.key === "Escape") {
							event.stopPropagation();
							onCancel();
						}
						if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
							event.preventDefault();
							if (!pending) send();
						}
					}}
				/>
				{/* Always in the tree, so a screen reader hears the words arrive. */}
				<p className={classes.note} id={`${testId}-note`} aria-live="polite">
					{tooShort && (
						<Trans>
							A few more words, so someone reading later understands.
						</Trans>
					)}
				</p>
				<div className={classes.reasonActions}>
					<button
						type="button"
						className={`${classes.control} ${classes.confirm}`}
						disabled={pending}
						onClick={send}
					>
						{confirmLabel}
					</button>
					<button
						type="button"
						className={`${classes.control} ${classes.cancel}`}
						onClick={onCancel}
					>
						<Trans>Cancel</Trans>
					</button>
				</div>
			</div>
		</div>
	);
}

function HistoryTimeline({
	revisions,
	actorName,
	onRestore,
	pending,
}: {
	revisions: AnalysisRevision[];
	actorName?: (actorId: string) => string | undefined;
	onRestore: (revision: AnalysisRevision) => void;
	pending: boolean;
}) {
	if (revisions.length === 0)
		return (
			<p className={classes.line}>
				<Trans>No history yet.</Trans>
			</p>
		);
	// Newest first: the last thing that happened is what a host looks for.
	const entries = [...revisions].reverse();
	return (
		<ol className={classes.timeline} data-testid="result-history">
			{entries.map((revision, index) => {
				const previous = entries[index + 1];
				const before = previous ? revisionWording(previous) : "";
				const after = revisionWording(revision);
				const actor = revision.actorId ? actorName?.(revision.actorId) : null;
				const who = revision.actorId ? (actor ?? t`A host`) : t`dembrane`;
				return (
					<li className={classes.entry} key={revision.revisionId}>
						<p className={classes.entryHead}>
							{who} · {whenWord(revision.publishedAt)}
						</p>
						<p className={classes.line}>
							{changeKindWord(changeKindOf(revision))}
						</p>
						{revision.reason && (
							<p className={classes.line}>{revision.reason}</p>
						)}
						{before && before !== after && (
							<del className={`${classes.wording} ${classes.before}`}>
								{before}
							</del>
						)}
						{after && <p className={classes.wording}>{after}</p>}
						{index > 0 && (
							<button
								type="button"
								className={`${classes.control} ${classes.quiet}`}
								disabled={pending}
								onClick={() => onRestore(revision)}
							>
								<Trans>Restore this wording</Trans>
							</button>
						)}
					</li>
				);
			})}
		</ol>
	);
}

export type ResultItemProps = ResultStageProps & {
	projectId: string;
	item: AnalysisObject;
	/** The workbench margin appears for hosts who may change the analysis. */
	canEdit?: boolean;
	/** Names for the people in the history, where the page knows them. */
	actorName?: (actorId: string) => string | undefined;
	/** "Open in Analysis", where that page exists for this reader. */
	analysisHref?: string | null;
	/** "Show on the map", where the finding is on one. */
	mapHref?: string | null;
	/** Closes the item where the page offers a way out. */
	onClose?: () => void;
	/**
	 * Seam for step 4: editing the words in place. No control is drawn until a
	 * page passes this.
	 */
	onEditWords?: (item: AnalysisObject) => void;
	/** Seam for step 5: holding a finding back from one presentation. */
	holdBack?: { held: boolean; onChange: (held: boolean) => void } | null;
	/** Seam for step 6: putting the card on the room screen. */
	onShowToRoom?: (() => void) | null;
	/** The audience theme, where the item sits outside a themed shell. */
	theme?: "light" | "dark";
};

/**
 * One finding, opened: the stage card a room would get, and for hosts who may
 * change the analysis, the workbench in the margin beside it (below it under
 * 900 px). No tabs, and every sub-step expands inside the item.
 */
export function ResultItem({
	actorName,
	analysisHref,
	canEdit = false,
	className,
	evidence,
	factCheck,
	holdBack,
	item,
	mapHref,
	onClose,
	onEditWords,
	onShowToRoom,
	projectId,
	quotes,
	theme,
}: ResultItemProps) {
	const [step, setStep] = useState<"rest" | "withdraw">("rest");
	const [restoring, setRestoring] = useState<AnalysisRevision | null>(null);
	const [conflict, setConflict] = useState(false);
	const [shown, setShown] = useState(item.revisionId);
	// History is the workbench's; a reader without the margin never fetches it.
	const history = useAnalysisObjectHistory(
		projectId,
		canEdit ? item.objectId : undefined,
	);
	const membership = useSetAnalysisMembership(projectId, item.objectId);
	const rollback = useRollbackAnalysisObject(projectId, item.objectId);
	const pending = membership.isPending || rollback.isPending;
	const withdrawn = Boolean(item.membershipExcluded);
	const provenance = (item.provenance ?? {}) as Record<string, unknown>;

	// A new revision arrived: the item goes back to rest rather than holding a
	// half-finished step over words that have since changed.
	if (shown !== item.revisionId) {
		setShown(item.revisionId);
		setStep("rest");
		setRestoring(null);
		setConflict(false);
	}

	const onError = (error: unknown) => {
		if ((error as { status?: number } | undefined)?.status === 409) {
			setConflict(true);
			void history.refetch();
		}
	};
	const settle = () => {
		setStep("rest");
		setRestoring(null);
		setConflict(false);
	};

	const withdraw = (reason: string) =>
		membership.mutate(
			{
				change_kind: "withdraw",
				excluded: true,
				expected_revision_id: item.revisionId,
				reason,
			},
			{ onError, onSuccess: settle },
		);
	const restore = () =>
		membership.mutate(
			{
				change_kind: "restore",
				excluded: false,
				expected_revision_id: item.revisionId,
				reason: t`Restored to the analysis`,
			},
			{ onError, onSuccess: settle },
		);
	const restoreWording = (revision: AnalysisRevision) =>
		rollback.mutate(
			{
				change_kind: "rollback",
				expected_revision_id: item.revisionId,
				reason: t`Restored the wording of revision ${revision.revisionNumber}`,
				to_revision_id: revision.revisionId,
			},
			{ onError, onSuccess: settle },
		);

	const origin = String(provenance.origin ?? "");
	const recipe = [provenance.recipeId, provenance.recipeVersion]
		.filter(Boolean)
		.join(" · ");

	return (
		<div
			className={[classes.item, className].filter(Boolean).join(" ")}
			data-testid="result-item"
			data-theme={theme}
		>
			<div className={`${classes.layout} ${canEdit ? "" : classes.stageOnly}`}>
				<ResultStage
					item={item}
					quotes={quotes}
					evidence={evidence}
					factCheck={factCheck}
				/>

				{canEdit && (
					<div className={classes.margin} data-testid="result-workbench">
						{/* What a host can do comes first, at the height of the finding,
						    so a long history never pushes it out of reach. The gentlest
						    control leads and the heaviest closes the group. */}
						<section className={`${classes.section} ${classes.actions}`}>
							{conflict && (
								<p className={classes.notice} data-testid="result-conflict">
									<Trans>
										Someone changed this while you had it open. Open it again to
										see their version.
									</Trans>
								</p>
							)}
							{onShowToRoom && (
								<button
									type="button"
									className={`${classes.control} ${classes.primary}`}
									onClick={onShowToRoom}
								>
									<Trans>Show to the room</Trans>
								</button>
							)}
							{onEditWords && (
								<button
									type="button"
									className={classes.control}
									onClick={() => onEditWords(item)}
								>
									<Trans>Change the words</Trans>
								</button>
							)}
							{holdBack && (
								<button
									type="button"
									className={classes.control}
									onClick={() => holdBack.onChange(!holdBack.held)}
								>
									{holdBack.held ? (
										<Trans>Put back in this presentation</Trans>
									) : (
										<Trans>Not in this presentation</Trans>
									)}
								</button>
							)}
							{withdrawn ? (
								<>
									<p className={classes.line}>
										<Trans>Withdrawn from the analysis.</Trans>
									</p>
									<button
										type="button"
										className={classes.control}
										disabled={pending}
										onClick={restore}
									>
										<Trans>Restore to the analysis</Trans>
									</button>
								</>
							) : step === "withdraw" ? (
								<ReasonStep
									testId="result-withdraw-reason"
									label={
										<Trans>
											Why? One sentence, for the people you work with and anyone
											who checks later.
										</Trans>
									}
									confirmLabel={<Trans>Withdraw from the analysis</Trans>}
									pending={membership.isPending}
									onCancel={() => setStep("rest")}
									onConfirm={withdraw}
								/>
							) : (
								<button
									type="button"
									className={classes.control}
									disabled={pending}
									onClick={() => setStep("withdraw")}
								>
									<Trans>Withdraw from the analysis</Trans>
								</button>
							)}
						</section>

						<section className={classes.section}>
							<p className={classes.sectionTitle}>
								<Trans>History</Trans>
							</p>
							{history.isError ? (
								<p className={classes.line}>
									<Trans>The history could not be loaded.</Trans>
								</p>
							) : (
								<HistoryTimeline
									revisions={history.data?.revisions ?? []}
									actorName={actorName}
									pending={pending}
									onRestore={(revision) => {
										setRestoring(revision);
										restoreWording(revision);
									}}
								/>
							)}
							{restoring && rollback.isPending && (
								<p className={classes.line}>
									<Trans>Restoring that wording.</Trans>
								</p>
							)}
						</section>

						<section
							className={classes.section}
							data-testid="result-provenance"
						>
							<p className={classes.sectionTitle}>
								<Trans>Where this came from</Trans>
							</p>
							<p className={classes.line}>
								{origin === "authored" ? (
									<Trans>Written by a host</Trans>
								) : origin === "imported" ? (
									<Trans>Imported</Trans>
								) : (
									<Trans>Prepared by an analysis run</Trans>
								)}
							</p>
							<p className={classes.line}>
								{recipe ? (
									<Trans>Recipe: {recipe}</Trans>
								) : (
									<Trans>Recipe not recorded</Trans>
								)}
							</p>
						</section>

						{(analysisHref || mapHref || onClose) && (
							<section className={`${classes.section} ${classes.actions}`}>
								{analysisHref && (
									<I18nLink className={classes.link} to={analysisHref}>
										<Trans>Open in Analysis</Trans>
									</I18nLink>
								)}
								{mapHref && (
									<I18nLink className={classes.link} to={mapHref}>
										<Trans>Show on the map</Trans>
									</I18nLink>
								)}
								{onClose && (
									<button
										type="button"
										className={classes.control}
										onClick={onClose}
									>
										<Trans>Close</Trans>
									</button>
								)}
							</section>
						)}
					</div>
				)}
			</div>
			{!canEdit && onClose && (
				<button type="button" className={classes.control} onClick={onClose}>
					<Trans>Close</Trans>
				</button>
			)}
		</div>
	);
}
