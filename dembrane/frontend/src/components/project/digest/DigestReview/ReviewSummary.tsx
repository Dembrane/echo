import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, Group, Stack, Text, Title } from "@mantine/core";
import { type ReactNode, useEffect, useRef } from "react";
import { testId } from "@/lib/testUtils";
import type { ReviewStep } from "../review";

export interface SummaryLine {
	step: ReviewStep;
	title: string;
	/** The part in one line; cut with an ellipsis when longer. */
	value: string;
	skipped: boolean;
}

interface ReviewSummaryProps {
	lines: readonly SummaryLine[];
	onChange: (step: ReviewStep) => void;
	canCreate: boolean;
	creating?: boolean;
	onCreate: () => void;
	footer: ReactNode;
}

const RULE = "var(--app-stroke) solid var(--app-rule-color)";

/**
 * The end of the stepped review (ECHO-1058): every part in one line, each with a way back
 * to change it, then Create. Nothing is saved before. Props in, callbacks out.
 */
export const ReviewSummary = ({
	lines,
	onChange,
	canCreate,
	creating = false,
	onCreate,
	footer,
}: ReviewSummaryProps) => {
	const headingRef = useRef<HTMLHeadingElement>(null);
	useEffect(() => {
		headingRef.current?.focus({ preventScroll: true });
	}, []);
	return (
		<Stack
			component="section"
			gap="lg"
			aria-labelledby="project-digest-title-summary"
			{...testId("project-digest-summary")}
		>
			<Stack gap="xs">
				<Text size="sm" className="app-muted">
					<Trans>Here is what dembrane understood</Trans>
				</Text>
				<Title
					order={3}
					ref={headingRef}
					tabIndex={-1}
					id="project-digest-title-summary"
					style={{ outline: "none" }}
				>
					<Trans>Ready to create</Trans>
				</Title>
				<Text size="sm">
					<Trans>
						Change any part, then create the project. Nothing is saved before.
					</Trans>
				</Text>
			</Stack>
			<Stack gap={0} component="ul" m={0} p={0} style={{ listStyle: "none" }}>
				{lines.map((line, i) => {
					const part = line.title;
					return (
						<Group
							key={line.step}
							component="li"
							gap="sm"
							wrap="nowrap"
							py="xs"
							style={{
								borderBottom: RULE,
								borderTop: i === 0 ? RULE : undefined,
							}}
							{...testId(`project-digest-summary-${line.step}`)}
						>
							<Text
								size="sm"
								className="app-muted"
								w={112}
								style={{ flexShrink: 0 }}
							>
								{line.title}
							</Text>
							<Text
								size="sm"
								truncate="end"
								className={
									line.skipped || !line.value ? "app-muted" : undefined
								}
								style={{ flex: 1, minWidth: 0 }}
							>
								{line.skipped ? t`Skipped` : line.value || t`Nothing yet`}
							</Text>
							<Button
								variant="subtle"
								size="compact-sm"
								onClick={() => onChange(line.step)}
								aria-label={t`Change: ${part}`}
								{...testId(`project-digest-summary-change-${line.step}`)}
							>
								<Trans>Change</Trans>
							</Button>
						</Group>
					);
				})}
			</Stack>
			<Group gap="sm">
				<Button
					variant="filled"
					size="sm"
					loading={creating}
					disabled={!canCreate}
					onClick={onCreate}
					{...testId("project-digest-create")}
				>
					<Trans>Create project</Trans>
				</Button>
			</Group>
			{footer}
		</Stack>
	);
};
