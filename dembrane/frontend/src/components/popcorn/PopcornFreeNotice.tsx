import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import type { FreePopcorn } from "@/components/popcorn/hooks";
import { usePricingConfigurator } from "@/components/pricing";
import { UpgradeModal } from "@/components/workspace/FeatureGate";
import { useFreeAllowance } from "@/hooks/useFreeAllowance";
import { formatResetDate } from "@/lib/freeTier";
import { testId } from "@/lib/testUtils";
import { SELLABLE_TIER } from "@/lib/tiers";

// The host's free popcorn meter; once used up, a calm notice with the upgrade wall.
export function PopcornFreeNotice({
	status,
	workspaceId,
	projectId,
}: {
	status: FreePopcorn | null | undefined;
	workspaceId: string;
	projectId: string;
}) {
	const { i18n } = useLingui();
	const allowance = useFreeAllowance(status?.exhausted ? workspaceId : null);
	const configurator = usePricingConfigurator("popcorn_cap");

	if (!status) return null;
	const { used, limit } = status;

	if (!status.exhausted) {
		return (
			<Text size="sm" c="dimmed" {...testId("popcorn-free-meter")}>
				<Trans>
					{used} of {limit} analyses used this month
				</Trans>
			</Text>
		);
	}

	const date = formatResetDate(allowance.data?.resets_at, i18n.locale);
	return (
		<Alert variant="light" color="gray" {...testId("popcorn-free-notice")}>
			<Stack gap="sm">
				<Text size="sm">
					{date ? (
						<Trans>
							You have used this month's free popcorn analyses. The results stay
							here. Analysis starts again on {date}.
						</Trans>
					) : (
						<Trans>
							You have used this month's free popcorn analyses. The results stay
							here.
						</Trans>
					)}
				</Text>
				<Group>
					<Button
						size="xs"
						variant="light"
						onClick={configurator.open}
						{...testId("popcorn-free-upgrade")}
					>
						{t`See upgrade options`}
					</Button>
				</Group>
			</Stack>
			<UpgradeModal
				opened={configurator.opened}
				onClose={configurator.close}
				currentTier="free"
				requiredTier={SELLABLE_TIER}
				canRequestUpgrade
				workspaceId={workspaceId}
				projectId={projectId}
				wallKey="popcorn_cap"
				entry="modal_direct"
			/>
		</Alert>
	);
}
