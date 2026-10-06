import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Box,
	Collapse,
	Group,
	Loader,
	Paper,
	Stack,
	Text,
	UnstyledButton,
} from "@mantine/core";
import {
	BellIcon,
	CaretDownIcon,
	CheckCircleIcon,
	CircleIcon,
	XCircleIcon,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { testId } from "@/lib/testUtils";
import type { AgenticPlan, PlanStepStatus } from "./agenticPlan";

const StepIcon = ({ status }: { status: PlanStepStatus }) => {
	// Every icon sits in the same 16px box so ticking a step off never moves
	// the text beside it.
	const box = "flex h-4 w-4 shrink-0 items-center justify-center";
	if (status === "done") {
		return (
			<span className={`${box} animate-[plan-tick_220ms_ease-out]`}>
				<CheckCircleIcon
					size={16}
					style={{ color: "var(--app-success)" }}
					aria-label={t`Done`}
				/>
			</span>
		);
	}
	if (status === "in_progress") {
		return (
			<span className={box} role="img" aria-label={t`In progress`}>
				<Loader size="xs" color="green" />
			</span>
		);
	}
	if (status === "stopped") {
		return (
			<span className={box}>
				<XCircleIcon
					size={16}
					style={{ color: "var(--mantine-color-dimmed)" }}
					aria-label={t`Stopped`}
				/>
			</span>
		);
	}
	return (
		<span className={box}>
			<CircleIcon
				size={16}
				style={{ color: "var(--mantine-color-dimmed)" }}
				aria-label={t`Not started`}
			/>
		</span>
	);
};

/** The agent's plan as a step list that ticks off as it works (sam's Slack plan
 * block, in the chat). Open while the turn runs; folds to one line once done. */
export const AgenticPlanCard = ({ plan }: { plan: AgenticPlan }) => {
	const doneCount = plan.steps.filter((step) => step.status === "done").length;
	const [open, setOpen] = useState(plan.live);

	// Unfold when a new turn goes live, fold when it finishes.
	useEffect(() => {
		setOpen(plan.live);
	}, [plan.live]);

	return (
		<Box className="flex justify-start" {...testId("agentic-plan")}>
			<Paper withBorder className="w-full max-w-full px-3 py-2 md:max-w-[80%]">
				<UnstyledButton
					onClick={() => setOpen((value) => !value)}
					className="w-full"
					aria-expanded={open}
					{...testId("agentic-plan-toggle")}
				>
					<Group justify="space-between" wrap="nowrap" gap="xs">
						<Text>
							<Trans>Plan</Trans>
						</Text>
						<Group gap="xs" wrap="nowrap">
							<Text size="xs" {...testId("agentic-plan-progress")}>
								<Trans>
									{doneCount} of {plan.steps.length} done
								</Trans>
							</Text>
							<CaretDownIcon
								size={16}
								className="transition-transform duration-200"
								style={{ transform: open ? "rotate(180deg)" : undefined }}
							/>
						</Group>
					</Group>
				</UnstyledButton>

				<Collapse in={open} transitionDuration={200}>
					<Stack gap="sm" mt="xs" component="ol" className="m-0 list-none p-0">
						{plan.steps.map((step, index) => (
							<Box
								component="li"
								key={`${index}-${step.title}`}
								{...testId(`agentic-plan-step-${step.status}`)}
							>
								<Group gap="sm" wrap="nowrap" align="flex-start">
									<Box pt={4}>
										<StepIcon status={step.status} />
									</Box>
									<Stack gap={0} className="min-w-0">
										<Text
											c={step.status === "in_progress" ? undefined : "dimmed"}
											className="transition-colors duration-200"
										>
											{step.title}
										</Text>
										{step.note && <Text size="xs">{step.note}</Text>}
									</Stack>
								</Group>
							</Box>
						))}
					</Stack>
					{plan.live && (
						<Group
							gap="xs"
							mt="sm"
							wrap="nowrap"
							{...testId("agentic-plan-close-hint")}
						>
							<BellIcon
								size={16}
								className="shrink-0"
								style={{ color: "var(--mantine-color-dimmed)" }}
							/>
							<Text size="xs">
								<Trans>
									You can close this page. We'll notify you when it's done.
								</Trans>
							</Text>
						</Group>
					)}
				</Collapse>
			</Paper>
		</Box>
	);
};
