import { Trans } from "@lingui/react/macro";
import {
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import classes from "./ResultsList.module.css";

export type ReasonOption = {
	/** What the caller gets back: a change kind, or a suggestion's own id. */
	key: string;
	label: ReactNode;
	/** The reason these words stand for, where the label is the reason. */
	reason?: string;
	/** Grows the prompt by one labelled field; the choice needs a sentence. */
	needsReason?: boolean;
};

export type ReasonChoice = { key: string; reason?: string };

export type ReasonPromptProps = {
	question: ReactNode;
	options: ReasonOption[];
	/** The option the caret rests on, so Enter, Enter can finish. */
	focusKey?: string;
	/** The label above the field, never a placeholder. */
	reasonLabel?: ReactNode;
	confirmLabel?: ReactNode;
	pending?: boolean;
	onCancel: () => void;
	onConfirm: (choice: ReasonChoice) => void;
	testId?: string;
	className?: string;
};

const MINIMUM = 4;

/**
 * The one line that asks what changed. It takes over the meta line it is
 * given, so no row moves, and only an option that needs a sentence grows the
 * row by one labelled field.
 */
export function ReasonPrompt({
	className,
	confirmLabel,
	focusKey,
	onCancel,
	onConfirm,
	options,
	pending,
	question,
	reasonLabel,
	testId = "reason-prompt",
}: ReasonPromptProps) {
	const [asked, setAsked] = useState<ReasonOption | null>(null);
	const [reason, setReason] = useState("");
	const [tooShort, setTooShort] = useState(false);
	const group = useRef<HTMLDivElement>(null);
	const field = useRef<HTMLTextAreaElement>(null);
	const resting = focusKey ?? options[0]?.key;

	// The caret arrives on the option the host is most likely to want, so a
	// typo is Enter, Enter and nothing else.
	useEffect(() => {
		const buttons = [
			...(group.current?.querySelectorAll<HTMLElement>("[data-option]") ?? []),
		];
		const first = buttons.find((button) => button.dataset.option === resting);
		(first ?? buttons[0])?.focus();
	}, [resting]);

	useEffect(() => {
		if (asked?.needsReason) field.current?.focus();
	}, [asked]);

	const choose = (option: ReasonOption) => {
		if (option.needsReason) {
			setAsked(option);
			return;
		}
		onConfirm({ key: option.key, reason: option.reason });
	};

	const send = () => {
		if (!asked) return;
		const written = reason.trim();
		// The server enforces the real minimum; this only keeps a host from
		// sending a reason nobody could read later.
		if (written.length < MINIMUM) {
			setTooShort(true);
			field.current?.focus();
			return;
		}
		onConfirm({ key: asked.key, reason: written });
	};

	// The prompt is a group of its own: Tab stays inside it, Escape backs out
	// one step and only one.
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Escape") {
			event.stopPropagation();
			event.preventDefault();
			if (asked) {
				setAsked(null);
				setTooShort(false);
				return;
			}
			onCancel();
			return;
		}
		if (event.key === "Tab") {
			const focusable = [
				...(group.current?.querySelectorAll<HTMLElement>("button, textarea") ??
					[]),
			];
			if (focusable.length === 0) return;
			const at = focusable.indexOf(document.activeElement as HTMLElement);
			const next = event.shiftKey ? at - 1 : at + 1;
			if (next >= 0 && next < focusable.length) return;
			event.preventDefault();
			focusable[event.shiftKey ? focusable.length - 1 : 0].focus();
			return;
		}
		// Keys are for choosing, never while the host is writing a sentence.
		if (asked) return;
		const digit = Number(event.key);
		if (Number.isInteger(digit) && digit >= 1 && digit <= options.length) {
			event.preventDefault();
			choose(options[digit - 1]);
		}
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: the group carries the keys its own controls answer to
		<div
			ref={group}
			className={[classes.prompt, className].filter(Boolean).join(" ")}
			data-testid={testId}
			onKeyDown={onKeyDown}
		>
			<p className={classes.promptQuestion}>{question}</p>
			{!asked && (
				<div className={classes.promptOptions}>
					{options.map((option) => (
						<button
							key={option.key}
							type="button"
							className={classes.control}
							data-option={option.key}
							disabled={pending}
							onClick={() => choose(option)}
						>
							{option.label}
						</button>
					))}
					<button
						type="button"
						className={`${classes.control} ${classes.cancel}`}
						onClick={onCancel}
					>
						<Trans>Cancel</Trans>
					</button>
				</div>
			)}
			{asked && (
				<div className={classes.promptField}>
					<label className={classes.promptLabel} htmlFor={`${testId}-field`}>
						{reasonLabel}
					</label>
					<textarea
						ref={field}
						id={`${testId}-field`}
						className={classes.field}
						rows={2}
						value={reason}
						aria-describedby={`${testId}-note`}
						onChange={(event) => {
							setReason(event.currentTarget.value);
							setTooShort(false);
						}}
						onKeyDown={(event) => {
							if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
								event.preventDefault();
								if (!pending) send();
							}
						}}
					/>
					<p className={classes.note} id={`${testId}-note`} aria-live="polite">
						{tooShort && (
							<Trans>
								A few more words, so someone reading later understands.
							</Trans>
						)}
					</p>
					<div className={classes.promptOptions}>
						<button
							type="button"
							className={`${classes.control} ${classes.confirm}`}
							disabled={pending}
							onClick={send}
						>
							{confirmLabel ?? <Trans>Save</Trans>}
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
			)}
		</div>
	);
}
