import { Text } from "@mantine/core";
import type { ReactNode } from "react";
import classes from "./TaskLine.module.css";

/**
 * One task as a line: its marker (empty while it is the customer's to do), the title and
 * one fact under it, the amount when money is involved, then its buttons, and anything
 * that opens under them.
 */
export function TaskLine({
	marker,
	title,
	fact,
	figure,
	actions,
	more,
	testId,
	...data
}: {
	marker?: ReactNode;
	title: ReactNode;
	fact?: ReactNode;
	figure?: ReactNode;
	actions?: ReactNode;
	more?: ReactNode;
	testId?: string;
} & Record<`data-${string}`, string | undefined>) {
	return (
		<li className={classes.line} data-testid={testId} {...data}>
			<div className={classes.marker}>{marker}</div>
			<div className={classes.words}>
				<Text lh={1.4}>{title}</Text>
				{fact && (
					<Text size="xs" c="dimmed" data-testid="task-fact">
						{fact}
					</Text>
				)}
			</div>
			<div className={classes.figure}>{figure}</div>
			{actions && <div className={classes.actions}>{actions}</div>}
			{more && <div className={classes.more}>{more}</div>}
		</li>
	);
}

/** The amount at the right of a line, with the VAT it includes under it. */
export function Figure({ amount, vat }: { amount: string; vat?: ReactNode }) {
	return (
		<>
			<Text size="md" lh={1.3} data-testid="task-figure">
				{amount}
			</Text>
			{vat && (
				<Text size="xs" c="dimmed">
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
