import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import { usePricingConfigurator } from "@/components/pricing";
import { useProjectById } from "@/components/project/hooks";
import { UpgradeModal } from "@/components/workspace/FeatureGate";
import { useFreeAllowance } from "@/hooks/useFreeAllowance";
import { allowanceSpent } from "@/lib/freeTier";
import { testId } from "@/lib/testUtils";

const formatDate = (iso: string | null | undefined, locale: string) => {
	if (!iso) return null;
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return null;
	return d.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
};

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
	// Sample projects are exempt; until is_sample loads nothing shows.
	const sampleQuery = useProjectById({
		projectId,
		query: { fields: ["id", "is_sample"] },
	});
	const applies =
		mapOn &&
		sampleQuery.isSuccess &&
		(sampleQuery.data as { is_sample?: boolean | null } | undefined)
			?.is_sample !== true;
	const allowance = useFreeAllowance(applies ? workspaceId : null);
	const configurator = usePricingConfigurator("map_cap");

	if (!applies || !allowanceSpent(allowance.data, "maps")) return null;

	const date = formatDate(allowance.data?.resets_at, i18n.locale);
	return (
		<Alert variant="light" color="gray" {...testId("map-free-notice")}>
			<Stack gap="sm">
				<Text size="sm">
					{date ? (
						<Trans>
							You have used this month's free map. The map in this presentation
							keeps its current version until {date}.
						</Trans>
					) : (
						<Trans>
							You have used this month's free map. The map in this presentation
							keeps its current version.
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
			<UpgradeModal
				opened={configurator.opened}
				onClose={configurator.close}
				currentTier="free"
				requiredTier={null}
				canRequestUpgrade
				workspaceId={workspaceId}
				projectId={projectId}
				wallKey="map_cap"
				entry="modal_direct"
			/>
		</Alert>
	);
}
