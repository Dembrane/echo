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
	IconBell,
	IconChevronDown,
	IconCircle,
	IconCircleCheckFilled,
	IconCircleX,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { testId } from "@/lib/testUtils";
import type { AgenticPlan, PlanStepStatus } from "./agenticPlan";

const StepIcon = ({ status }: { status: PlanStepStatus }) => {
	// Every icon sits in the same 18px box so ticking a step off never moves
	// the text beside it.
	const box = "flex h-[18px] w-[18px] shrink-0 items-center justify-center";
	if (status === "done") {
		return (
			<span className={`${box} animate-[plan-tick_220ms_ease-out]`}>
				<IconCircleCheckFilled
					size={18}
					style={{ color: "var(--mantine-color-teal-6)" }}
					aria-label={t`Done`}
				/>
			</span>
		);
	}
	if (status === "in_progress") {
		return (
			<span className={box} role="img" aria-label={t`In progress`}>
				<Loader size={14} color="teal" />
			</span>
		);
	}
	if (status === "stopped") {
		return (
			<span className={box}>
				<IconCircleX
					size={18}
					style={{ color: "var(--mantine-color-gray-5)" }}
					aria-label={t`Stopped`}
				/>
			</span>
		);
	}
	return (
		<span className={box}>
			<IconCircle
				size={18}
				style={{ color: "var(--mantine-color-gray-4)" }}
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
			<Paper
				withBorder
				radius="md"
				className="w-full max-w-full px-3 py-2 md:max-w-[80%]"
			>
				<UnstyledButton
					onClick={() => setOpen((value) => !value)}
					className="w-full"
					aria-expanded={open}
					{...testId("agentic-plan-toggle")}
				>
					<Group justify="space-between" wrap="nowrap" gap="xs">
						<Text fw={600}>
							<Trans>Plan</Trans>
						</Text>
						<Group gap={6} wrap="nowrap">
							<Text size="xs" {...testId("agentic-plan-progress")}>
								<Trans>
									{doneCount} of {plan.steps.length} done
								</Trans>
							</Text>
							<IconChevronDown
								size={14}
								className="transition-transform duration-200"
								style={{ transform: open ? "rotate(180deg)" : undefined }}
							/>
						</Group>
					</Group>
				</UnstyledButton>

				<Collapse in={open} transitionDuration={200}>
					<Stack gap={8} mt="xs" component="ol" className="m-0 list-none p-0">
						{plan.steps.map((step, index) => (
							<Box
								component="li"
								key={`${index}-${step.title}`}
								{...testId(`agentic-plan-step-${step.status}`)}
							>
								<Group gap={10} wrap="nowrap" align="flex-start">
									<Box pt={4}>
										<StepIcon status={step.status} />
									</Box>
									<Stack gap={0} className="min-w-0">
										<Text
											fw={step.status === "in_progress" ? 600 : 400}
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
							gap={6}
							mt="sm"
							wrap="nowrap"
							{...testId("agentic-plan-close-hint")}
						>
							<IconBell
								size={14}
								className="shrink-0"
								style={{ color: "var(--mantine-color-gray-6)" }}
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
