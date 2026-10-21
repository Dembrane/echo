import { plural, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import { usePricingConfigurator } from "@/components/pricing";
import { UpgradeModal } from "@/components/workspace/FeatureGate";
import { useAllowanceApplies } from "@/hooks/useAllowanceApplies";
import { useFreeAllowance } from "@/hooks/useFreeAllowance";
import { allowanceSpent, formatResetDate } from "@/lib/freeTier";
import { testId } from "@/lib/testUtils";
import { SELLABLE_TIER } from "@/lib/tiers";

type BlockSettings = { presentation?: { blocks?: readonly string[] } };

/** True when the published or the draft presentation shows the map. */
export const presentsMap = (
	published: BlockSettings | null | undefined,
	draft: BlockSettings | null | undefined,
): boolean =>
	[published, draft].some((s) => s?.presentation?.blocks?.includes("map"));

// Host only: the free map is used, so the presented map stops updating.
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
	const configurator = usePricingConfigurator("map_cap");

	if (!applies || !allowanceSpent(allowance.data, "maps")) return null;

	const date = formatResetDate(allowance.data?.resets_at, i18n.locale);
	const limit = allowance.data?.maps?.limit ?? 1;
	return (
		<Alert variant="light" color="gray" {...testId("map-free-notice")}>
			<Stack gap="sm">
				<Text size="sm">
					{limit <= 0
						? date
							? t`You have used this month's free maps. The map in this presentation keeps its current version until ${date}.`
							: t`You have used this month's free maps. The map in this presentation keeps its current version.`
						: date
							? plural(limit, {
									one: `You have used this month's free map. The map in this presentation keeps its current version until ${date}.`,
									other: `You have used this month's # free maps. The map in this presentation keeps its current version until ${date}.`,
								})
							: plural(limit, {
									one: "You have used this month's free map. The map in this presentation keeps its current version.",
									other:
										"You have used this month's # free maps. The map in this presentation keeps its current version.",
								})}
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
			<UpgradeModal
				opened={configurator.opened}
				onClose={configurator.close}
				currentTier="free"
				requiredTier={SELLABLE_TIER}
				canRequestUpgrade
				workspaceId={workspaceId}
				projectId={projectId}
				wallKey="map_cap"
				entry="modal_direct"
			/>
		</Alert>
	);
}
