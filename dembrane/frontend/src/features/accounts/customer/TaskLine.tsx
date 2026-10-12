import { Text } from "@mantine/core";
import {
	CalendarBlankIcon,
	ChatCircleTextIcon,
	CompassIcon,
	NotePencilIcon,
	ReceiptIcon,
	SignatureIcon,
	UploadSimpleIcon,
	UsersThreeIcon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { TaskT } from "../contract/contract.gen";
import classes from "./TaskLine.module.css";

/**
 * One task as a line: the icon of its kind, the title and one fact under it (which also
 * says its state), the amount when money is involved, then its buttons.
 */
export function TaskLine({
	marker,
	title,
	fact,
	figure,
	actions,
	testId,
	...data
}: {
	marker?: ReactNode;
	title: ReactNode;
	fact?: ReactNode;
	figure?: ReactNode;
	actions?: ReactNode;
	testId?: string;
} & Record<`data-${string}`, string | undefined>) {
	return (
		<li className={classes.line} data-testid={testId} {...data}>
			<div className={classes.marker}>{marker}</div>
			<div className={classes.words}>
				<Text lh="24px">{title}</Text>
				{fact && (
					<Text size="xs" lh="20px" c="dimmed" data-testid="task-fact">
						{fact}
					</Text>
				)}
			</div>
			<div className={classes.figure}>{figure}</div>
			{actions && <div className={classes.actions}>{actions}</div>}
		</li>
	);
}

/** The amount at the right of a line, with the VAT it includes under it. */
export function Figure({ amount, vat }: { amount: string; vat?: ReactNode }) {
	return (
		<>
			<Text size="md" lh="24px" data-testid="task-figure">
				{amount}
			</Text>
			{vat && (
				<Text size="xs" lh="20px" c="dimmed">
					{vat}
				</Text>
			)}
		</>
	);
}

/** Spread on a Button: the outlined secondary of a task line. */
export const secondary = {
	className: classes.secondary,
	variant: "outline",
} as const;

/** What the customer does, as the line's icon: decide, sign, pay, fill in, answer… */
export type TaskKind =
	| "decide"
	| "sign"
	| "pay"
	| "fill_in"
	| "answer"
	| "upload"
	| "book"
	| "try";

const KIND_ICON = {
	answer: ChatCircleTextIcon,
	book: CalendarBlankIcon,
	decide: UsersThreeIcon,
	fill_in: NotePencilIcon,
	pay: ReceiptIcon,
	sign: SignatureIcon,
	try: CompassIcon,
	upload: UploadSimpleIcon,
} as const;

export const kindOf = (task: TaskT): TaskKind =>
	task.code === "who_signs"
		? "decide"
		: task.kind === "sign"
			? "sign"
			: task.kind === "billing_details"
				? "fill_in"
				: task.kind === "upload"
					? "upload"
					: task.code === "book_call"
						? "book"
						: task.code === "explore_demo" ||
								task.code === "watch_tutorial" ||
								task.code === "create_project"
							? "try"
							: "answer";

/** The kind's icon: in the text colour while it is the customer's to do, else muted. */
export function KindIcon({ kind, quiet }: { kind: TaskKind; quiet?: boolean }) {
	const Icon = KIND_ICON[kind];
	return (
		<Icon
			size={20}
			weight="light"
			color={quiet ? "var(--app-muted)" : "var(--app-text)"}
			aria-hidden
			data-kind={kind}
		/>
	);
}
