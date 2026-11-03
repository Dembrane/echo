import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Alert, Button, Stack, Text } from "@mantine/core";
import { LockIcon } from "@phosphor-icons/react";
import { UpgradeModal } from "@/components/workspace/FeatureGate";
import { useWorkspace } from "@/hooks/useWorkspace";
import type { Tier } from "@/lib/tiers";

// The single purchasable tier today (mirrors backend FREE_TIER_UPGRADE_CTA_TIER).
const UPGRADE_TIER: Tier = "changemaker";

/** The recording-hours cap, reached from the composer's microphone. */
export function VoiceCapUpgradeModal({
	opened,
	onClose,
	upgradeTier,
}: {
	opened: boolean;
	onClose: () => void;
	upgradeTier: string | null;
}) {
	const { workspace } = useWorkspace();
	const isAdmin = workspace?.role === "admin" || workspace?.role === "owner";
	return (
		<UpgradeModal
			opened={opened}
			onClose={onClose}
			currentTier={(workspace?.tier ?? "free") as Tier}
			requiredTier={(upgradeTier ?? UPGRADE_TIER) as Tier}
			canRequestUpgrade={isAdmin}
			workspaceId={workspace?.id ?? ""}
			wallKey="chat_voice_cap"
		/>
	);
}

/** Inline card in a sample project's chat once its free turns are used. */
export function ChatTurnLimitCard({ onUpgrade }: { onUpgrade: () => void }) {
	return (
		<Alert
			color="gray"
			icon={<LockIcon size={20} />}
			title={<Trans>Upgrade to continue</Trans>}
		>
			<Stack gap="sm" align="flex-start">
				<Text size="sm">
					<Trans>
						You've reached the free plan limit for this chat. Upgrade to keep
						the conversation going.
					</Trans>
				</Text>
				<Button size="xs" onClick={onUpgrade}>
					{t`See upgrade options`}
				</Button>
			</Stack>
		</Alert>
	);
}
