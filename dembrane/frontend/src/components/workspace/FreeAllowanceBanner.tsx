import { plural, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import { usePricingConfigurator } from "@/components/pricing";
import { UpgradeModal } from "@/components/workspace/FeatureGate";
import type { WallKey } from "@/components/workspace/gateWalls";
import { useFreeAllowance } from "@/hooks/useFreeAllowance";
import { allowanceSpent } from "@/lib/freeTier";
import { testId } from "@/lib/testUtils";

type Feature = "chats" | "reports" | "maps";

const WALLS: Record<Feature, WallKey> = {
	chats: "chat_cap",
	maps: "map_cap",
	reports: "report_cap",
};

const formatDate = (iso: string | null, locale: string): string => {
	const d = new Date(iso ?? "");
	if (Number.isNaN(d.getTime())) return iso ?? "";
	return d.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
};

// Shown on free accounts once this month's chats, report or map are used up.
export function FreeAllowanceBanner({
	workspaceId,
	feature,
}: {
	workspaceId: string;
	feature: Feature;
}) {
	const { i18n } = useLingui();
	const { data } = useFreeAllowance(workspaceId);
	const wallKey = WALLS[feature];
	const configurator = usePricingConfigurator(wallKey);

	if (!data || !allowanceSpent(data, feature)) return null;
	const date = formatDate(data.resets_at, i18n.locale);
	const limit = data[feature]?.limit ?? 1;

	return (
		<Alert variant="light" color="gray" {...testId("free-allowance-banner")}>
			<Stack gap="sm">
				<Text size="sm">
					{feature === "chats" && (
						<Trans>
							You have used this month's free chats. They reset on {date}.
						</Trans>
					)}
					{feature === "reports" &&
						limit <= 0 &&
						t`You have used this month's free reports. They reset on ${date}.`}
					{feature === "reports" &&
						limit > 0 &&
						plural(limit, {
							one: `You have used this month's free report. It resets on ${date}.`,
							other: `You have used this month's # free reports. They reset on ${date}.`,
						})}
					{feature === "maps" &&
						limit <= 0 &&
						t`You have used this month's free maps. Your current maps stay here. They reset on ${date}.`}
					{feature === "maps" &&
						limit > 0 &&
						plural(limit, {
							one: `You have used this month's free map. Your current map stays here. It resets on ${date}.`,
							other: `You have used this month's # free maps. Your current maps stay here. They reset on ${date}.`,
						})}
				</Text>
				<Group>
					<Button
						size="xs"
						variant="light"
						onClick={configurator.open}
						{...testId("free-allowance-banner-upgrade")}
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
				wallKey={wallKey}
				entry="modal_direct"
			/>
		</Alert>
	);
}
