import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import { usePricingConfigurator } from "@/components/pricing";
import { AiBudgetWall } from "@/components/workspace/AiBudgetWall";
import { useAllowanceApplies } from "@/hooks/useAllowanceApplies";
import { useFreeAllowance } from "@/hooks/useFreeAllowance";
import { formatResetDay } from "@/lib/freeTier";
import { testId } from "@/lib/testUtils";

type BlockSettings = { presentation?: { blocks?: readonly string[] } };

/** True when the published or the draft presentation shows the map. */
export const presentsMap = (
	published: BlockSettings | null | undefined,
	draft: BlockSettings | null | undefined,
): boolean =>
	[published, draft].some((s) => s?.presentation?.blocks?.includes("map"));

// Host only: this month's AI is used up, so the presented map stops updating.
export function MapFreeNotice({
	mapOn,
	workspaceId,
	projectId,
}: {
	mapOn: boolean;
	workspaceId: string;
	projectId: string;
}) {
	const { i18n } = useLingui();
	const applies = useAllowanceApplies(projectId).applies && mapOn;
	const allowance = useFreeAllowance(applies ? workspaceId : null);
	const configurator = usePricingConfigurator("map_ai_budget");

	const data = allowance.data;
	if (!applies || !data?.free || !data.ai?.exhausted) return null;

	const date = formatResetDay(data.resets_at, i18n.locale);
	return (
		<Alert variant="light" color="gray" {...testId("map-free-notice")}>
			<Stack gap="sm">
				<Text size="sm">
					{date ? (
						<Trans>
							This month's AI is used up, so the map can't update until {date}.
						</Trans>
					) : (
						<Trans>
							This month's AI is used up, so the map can't update until next
							month.
						</Trans>
					)}
				</Text>
				<Group>
					<Button
						size="xs"
						variant="light"
						onClick={configurator.open}
						{...testId("map-free-upgrade")}
					>
						{t`See upgrade options`}
					</Button>
				</Group>
			</Stack>
			<AiBudgetWall
				opened={configurator.opened}
				onClose={configurator.close}
				action="map"
				resetsAt={data.resets_at}
				workspaceId={workspaceId}
				projectId={projectId}
			/>
		</Alert>
	);
}
