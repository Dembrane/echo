import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import { usePricingConfigurator } from "@/components/pricing";
import { AiBudgetWall } from "@/components/workspace/AiBudgetWall";
import { UpgradeModal } from "@/components/workspace/FeatureGate";
import type { AiAction } from "@/components/workspace/gateWalls";
import { type FreeAllowance, useFreeAllowance } from "@/hooks/useFreeAllowance";
import { audioUsedUp, formatResetDate, formatResetDay } from "@/lib/freeTier";
import { testId } from "@/lib/testUtils";
import { SELLABLE_TIER } from "@/lib/tiers";

type Feature = "ai" | "audio";

// The AI banner shows from this share of the month's budget (inclusive).
const AI_WARN_PERCENT = 80;

/** The AI meter state the banner shows, or null when it shows none. */
function aiBannerState(
	s: FreeAllowance | undefined,
): { exhausted: boolean; percent: number } | null {
	const ai = s?.free ? s.ai : null;
	// Nothing stops while staff turned the check off, so no banner says it will.
	if (!ai || ai.unlimited || ai.enforced === false) return null;
	if (!ai.exhausted && ai.percent_used < AI_WARN_PERCENT) return null;
	return { exhausted: ai.exhausted, percent: Math.min(100, ai.percent_used) };
}

// Shown on free accounts from 80% of this month's AI, or once the month's audio is used up.
export function FreeAllowanceBanner({
	workspaceId,
	feature,
	action,
}: {
	workspaceId: string;
	feature: Feature;
	// The action the AI wall names; none on the allowance card.
	action?: AiAction;
}) {
	const { i18n } = useLingui();
	const { data } = useFreeAllowance(workspaceId);
	const configurator = usePricingConfigurator(
		feature === "ai" ? "ai_budget_banner" : "free_allowance",
	);

	const aiState = feature === "ai" ? aiBannerState(data) : null;
	const shown =
		feature === "ai"
			? !!aiState
			: !!data?.free && !!data.audio_seconds && audioUsedUp(data.audio_seconds);
	if (!data || !shown) return null;
	// The AI budget resets at 00:00 UTC on the 1st, so it names the day only.
	const date =
		(feature === "ai"
			? formatResetDay(data.resets_at, i18n.locale)
			: formatResetDate(data.resets_at, i18n.locale)) ?? "";
	const percent = aiState?.percent ?? 0;

	return (
		<Alert variant="light" color="gray" {...testId("free-allowance-banner")}>
			<Stack gap="sm">
				<Text size="sm">
					{feature === "audio" && (
						<Trans>
							You have used this month's free recording time. New recordings and
							uploads are paused until it resets on {date}.
						</Trans>
					)}
					{aiState?.exhausted && (
						<Trans>
							This month's AI is used up. AI features and new recordings are
							paused until {date}.
						</Trans>
					)}
					{aiState && !aiState.exhausted && (
						<Trans>
							You've used {percent}% of this month's AI. When it runs out, AI
							features and new recordings stop until {date}.
						</Trans>
					)}
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
			{feature === "ai" ? (
				<AiBudgetWall
					opened={configurator.opened}
					onClose={configurator.close}
					action={action}
					usedUp={!!aiState?.exhausted}
					resetsAt={data.resets_at}
					workspaceId={workspaceId}
				/>
			) : (
				<UpgradeModal
					opened={configurator.opened}
					onClose={configurator.close}
					currentTier="free"
					requiredTier={SELLABLE_TIER}
					canRequestUpgrade
					workspaceId={workspaceId}
					wallKey="free_allowance"
					entry="modal_direct"
				/>
			)}
		</Alert>
	);
}
