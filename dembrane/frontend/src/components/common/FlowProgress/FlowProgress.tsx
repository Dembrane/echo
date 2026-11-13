import { t } from "@lingui/core/macro";
import classes from "./FlowProgress.module.css";

interface FlowProgressProps {
	/** The step shown, from 1. */
	step: number;
	total: number;
	testId?: string;
}

/**
 * Where the host is in a stepped flow (ECHO-1058): a thin line in place of a stepper, so
 * the screen holds one thing at a time. A progress bar to a screen reader, "Step 2 of 5".
 */
export const FlowProgress = ({
	step,
	total,
	testId = "flow-progress",
}: FlowProgressProps) => {
	const shown = Math.min(Math.max(step, 1), Math.max(total, 1));
	const label = t`Step ${shown} of ${total}`;
	return (
		<div
			className={classes.track}
			role="progressbar"
			aria-label={label}
			aria-valuemin={1}
			aria-valuemax={total}
			aria-valuenow={shown}
			aria-valuetext={label}
			data-testid={testId}
		>
			<div
				className={classes.fill}
				style={{ width: `${(shown / Math.max(total, 1)) * 100}%` }}
			/>
		</div>
	);
};
