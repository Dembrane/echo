import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Popover, Tooltip } from "@mantine/core";
import {
	ArrowRightIcon,
	EyeSlashIcon,
	ListMagnifyingGlassIcon,
	PencilSimpleIcon,
	ThumbsDownIcon,
	ThumbsUpIcon,
} from "@phosphor-icons/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { AnalysisObject } from "@/components/analysis/hooks";
import { I18nLink } from "@/components/common/i18nLink";
import {
	FEEDBACK_NOTE_TAG,
	FEEDBACK_TAGS,
	type FeedbackRating,
	type ResultFeedbackActions,
} from "../feedback/useResultFeedback";
import { burstFrom } from "./confetti";
import classes from "./curate.module.css";
import type { Hide } from "./useHide";
import type { RowEdit } from "./useRowEdit";

/** How long "Thanks!" stays before the popover closes itself. */
const THANKS_MS = 2500;

/** The words on each tick, per polarity, in the order the wireframe has them. */
const tagWords = (tag: string): ReactNode => {
	switch (tag) {
		case "recognizable":
			return <Trans>Recognizable</Trans>;
		case "relevant":
			return <Trans>Relevant</Trans>;
		case "felt_heard":
			return <Trans>Felt heard</Trans>;
		case "not_recognizable":
			return <Trans>Not recognizable</Trans>;
		case "not_relevant":
			return <Trans>Not relevant</Trans>;
		case "tone_deaf":
			return <Trans>Tone deaf</Trans>;
		default:
			return <Trans>Other, namely</Trans>;
	}
};

/**
 * One tool. The glyph carries its own name to a screen reader and its own
 * tooltip to a mouse; a tool that is on is blue and stays visible when the row
 * is not hovered, in the place it always has, so no icon ever moves.
 */
export function Tool({
	icon,
	label,
	on,
	onClick,
	pressed,
	testId,
	innerRef,
}: {
	icon: ReactNode;
	label: string;
	on?: boolean;
	onClick?: () => void;
	pressed?: boolean;
	testId: string;
	innerRef?: React.Ref<HTMLButtonElement>;
}) {
	return (
		<Tooltip label={label} withinPortal>
			<button
				ref={innerRef}
				type="button"
				aria-label={label}
				aria-pressed={pressed}
				className={classes.tool}
				data-on={on || undefined}
				data-testid={testId}
				onClick={onClick}
			>
				{icon}
			</button>
		</Tooltip>
	);
}

/** What the popover is showing: the ticks, the thanks, or the two ways on. */
type Step = "asking" | "thanks" | "next" | null;

function FeedbackForm({
	rating,
	chosen,
	onSend,
}: {
	rating: FeedbackRating;
	chosen: { tags: string[]; note?: string } | null;
	onSend: (tags: string[], note?: string) => void;
}) {
	const [tags, setTags] = useState<string[]>(chosen?.tags ?? []);
	const [note, setNote] = useState(chosen?.note ?? "");
	const other = tags.includes(FEEDBACK_NOTE_TAG);

	return (
		<div className={classes.feedback}>
			<p className={classes.feedbackHead}>
				<Trans>Leave feedback</Trans>
			</p>
			<p className={classes.feedbackSub}>
				<Trans>Tick as many as relevant</Trans>
			</p>
			{FEEDBACK_TAGS[rating].map((tag) => (
				<label className={classes.tick} key={tag}>
					<input
						checked={tags.includes(tag)}
						data-testid={`curate-tag-${tag}`}
						onChange={() =>
							setTags((old) =>
								old.includes(tag)
									? old.filter((held) => held !== tag)
									: [...old, tag],
							)
						}
						type="checkbox"
					/>
					<span>{tagWords(tag)}</span>
				</label>
			))}
			<div className={classes.sendLine}>
				{/* The field appears only for the tick that needs it, so the popover
				    is four lines until the host asks for a fifth. */}
				{other && (
					<input
						aria-label={t`In your own words`}
						className={classes.noteField}
						data-testid="curate-feedback-note"
						onChange={(event) => setNote(event.currentTarget.value)}
						type="text"
						value={note}
					/>
				)}
				<button
					type="button"
					aria-label={t`Send feedback`}
					className={classes.send}
					data-testid="curate-feedback-send"
					onClick={() =>
						onSend(tags, other ? note.trim() || undefined : undefined)
					}
				>
					<ArrowRightIcon aria-hidden size={16} />
				</button>
			</div>
		</div>
	);
}

export type RowToolsProps = {
	item: AnalysisObject;
	analysisHref: string;
	hide: Hide;
	edit: RowEdit;
	feedback: ResultFeedbackActions;
};

/**
 * The five things a host does to a finding, in one place on every row: good,
 * not good, out of this presentation, reworded, and the whole picture.
 *
 * A rating counts on the click. The popover that follows is an offer, not a
 * toll: it asks what made the finding good and it can be walked away from,
 * because a host reading 146 findings will give a thumb to twenty of them and
 * a sentence to none.
 */
export function RowTools({
	analysisHref,
	edit,
	feedback,
	hide,
	item,
}: RowToolsProps) {
	const mine = feedback.feedbackFor(item);
	const [open, setOpen] = useState<FeedbackRating | null>(null);
	const [step, setStep] = useState<Step>(null);
	const thumbUp = useRef<HTMLButtonElement>(null);
	const thumbDown = useRef<HTMLButtonElement>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
		},
		[],
	);

	const close = () => {
		setOpen(null);
		setStep(null);
	};

	const press = (rating: FeedbackRating) => {
		if (mine?.rating === rating) {
			// The same thumb again takes the rating back, and the popover with it.
			feedback.rate(item.objectId, item.revisionId, null);
			close();
			return;
		}
		feedback.rate(item.objectId, item.revisionId, { rating, tags: [] });
		setOpen(rating);
		setStep("asking");
	};

	const send = (rating: FeedbackRating, tags: string[], note?: string) => {
		feedback.rate(item.objectId, item.revisionId, { note, rating, tags });
		if (rating === "down") {
			setStep("next");
			return;
		}
		setStep("thanks");
		burstFrom(thumbUp.current);
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(close, THANKS_MS);
	};

	const thumb = (rating: FeedbackRating) => {
		const on = mine?.rating === rating;
		const label = rating === "up" ? t`Good finding` : t`Not a good finding`;
		return (
			<Popover
				key={rating}
				opened={open === rating}
				onChange={(opened) => {
					// Escape and a click outside both arrive here; the focus goes back
					// to the thumb, which is where the host left it.
					if (!opened) close();
				}}
				position="bottom"
				returnFocus
				shadow="sm"
				// No fade. The popover follows the click that asked for it, and a
				// host who turned motion down gets the same thing as everyone else.
				transitionProps={{ duration: 0 }}
				trapFocus
				withArrow
				width={240}
			>
				<Popover.Target>
					{/* The tooltip and the popover both anchor on the thumb itself, so
					    the button is written out here rather than borrowed from
					    `Tool`: each wrapper merges its ref into the one below it. */}
					<Tooltip label={label} withinPortal>
						<button
							ref={rating === "up" ? thumbUp : thumbDown}
							type="button"
							aria-label={label}
							aria-pressed={on}
							className={classes.tool}
							data-on={on || undefined}
							data-testid={`curate-${rating}-${item.objectId}`}
							onClick={() => press(rating)}
						>
							{rating === "up" ? (
								<ThumbsUpIcon aria-hidden size={18} />
							) : (
								<ThumbsDownIcon aria-hidden size={18} />
							)}
						</button>
					</Tooltip>
				</Popover.Target>
				<Popover.Dropdown
					className={classes.popover}
					{...{ "data-testid": `curate-feedback-${item.objectId}` }}
				>
					{step === "thanks" ? (
						<p className={classes.thanks} data-testid="curate-feedback-thanks">
							<Trans>Thanks! That helps a lot.</Trans>
						</p>
					) : step === "next" ? (
						<div className={classes.nextStep}>
							<button
								type="button"
								className={classes.nextButton}
								data-testid={`curate-feedback-edit-${item.objectId}`}
								onClick={() => {
									close();
									edit.start();
								}}
							>
								<Trans>Edit</Trans>
								<PencilSimpleIcon aria-hidden size={16} />
							</button>
							<button
								type="button"
								className={classes.nextButton}
								data-testid={`curate-feedback-hide-${item.objectId}`}
								onClick={() => {
									close();
									hide.hide();
								}}
							>
								<Trans>Hide</Trans>
								<EyeSlashIcon aria-hidden size={16} />
							</button>
						</div>
					) : (
						<FeedbackForm
							chosen={mine}
							onSend={(tags, note) => send(rating, tags, note)}
							rating={rating}
						/>
					)}
				</Popover.Dropdown>
			</Popover>
		);
	};

	return (
		<div
			className={classes.tools}
			data-testid={`curate-tools-${item.objectId}`}
		>
			{thumb("up")}
			{thumb("down")}
			<Tool
				icon={<EyeSlashIcon aria-hidden size={18} />}
				label={hide.held ? t`Show again` : t`Hide from this presentation`}
				on={hide.held}
				onClick={hide.held ? hide.show : hide.hide}
				pressed={hide.held}
				testId={`curate-hide-${item.objectId}`}
			/>
			<Tool
				icon={<PencilSimpleIcon aria-hidden size={18} />}
				innerRef={edit.pencil}
				label={t`Edit`}
				on={edit.on || edit.lit}
				onClick={edit.toggle}
				pressed={edit.on}
				testId={`curate-edit-${item.objectId}`}
			/>
			{/* A link, not a button: the whole picture of a finding is a place,
			    and a host opens a place in a new tab when they want to. The span
			    carries the tooltip's ref, which `I18nLink` does not take. */}
			<Tooltip label={t`Open in Analysis`} withinPortal>
				<span className={classes.toolWrap}>
					<I18nLink
						aria-label={t`Open in Analysis`}
						className={classes.tool}
						to={analysisHref}
						{...{ "data-testid": `curate-analysis-${item.objectId}` }}
					>
						<ListMagnifyingGlassIcon aria-hidden size={18} />
					</I18nLink>
				</span>
			</Tooltip>
		</div>
	);
}
