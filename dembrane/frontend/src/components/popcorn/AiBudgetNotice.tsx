import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { AiBudgetWall } from "@/components/workspace/AiBudgetWall";
import { useFreeAllowance } from "@/hooks/useFreeAllowance";
import { formatResetDay } from "@/lib/freeTier";
import { testId } from "@/lib/testUtils";

// Host only: this month's AI is used up, so popcorn pauses until the reset.
export function AiBudgetNotice({
	status,
	workspaceId,
	projectId,
}: {
	status: { exhausted: boolean } | null | undefined;
	workspaceId: string;
	projectId: string;
}) {
	const { i18n } = useLingui();
	const allowance = useFreeAllowance(status?.exhausted ? workspaceId : null);
	const [upgradeOpened, upgradeHandlers] = useDisclosure(false);

	if (!status?.exhausted) return null;

	const resetsAt = allowance.data?.resets_at ?? null;
	const date = formatResetDay(resetsAt, i18n.locale);
	return (
		<Alert variant="light" color="gray" {...testId("popcorn-ai-budget-notice")}>
			<Stack gap="sm">
				<Text size="sm">
					{date ? (
						<Trans>
							This month's AI is used up, so popcorn is paused until {date}.
						</Trans>
					) : (
						<Trans>
							This month's AI is used up, so popcorn is paused until next month.
						</Trans>
					)}
				</Text>
				<Group>
					<Button
						size="xs"
						variant="light"
						onClick={upgradeHandlers.open}
						{...testId("popcorn-ai-budget-upgrade")}
					>
						{t`See upgrade options`}
					</Button>
				</Group>
			</Stack>
			<AiBudgetWall
				opened={upgradeOpened}
				onClose={upgradeHandlers.close}
				action="popcorn"
				resetsAt={resetsAt}
				workspaceId={workspaceId}
				projectId={projectId}
			/>
		</Alert>
	);
}
