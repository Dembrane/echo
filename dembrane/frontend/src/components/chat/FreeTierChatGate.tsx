import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Alert, Button, Stack, Text } from "@mantine/core";
import { LockIcon } from "@phosphor-icons/react";
import { UpgradeModal } from "@/components/workspace/FeatureGate";
import { SAMPLE_CHAT_QUESTIONS } from "@/components/workspace/gateWalls";
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

/** Inline card in a sample project's chat once the project's questions are used (all its chats share them). */
export function ChatTurnLimitCard({
	onUpgrade,
	questions,
}: {
	onUpgrade: () => void;
	// The cap the chat_turns refusal carried; none falls back to the default.
	questions?: number | null;
}) {
	const count = questions ?? SAMPLE_CHAT_QUESTIONS;
	return (
		<Alert
			color="gray"
			icon={<LockIcon size={20} />}
			title={<Trans>Upgrade to continue</Trans>}
		>
			<Stack gap="sm" align="flex-start">
				<Text size="sm">
					<Trans>
						You've used this sample project's {count} questions. Create your own
						project or upgrade to keep going.
					</Trans>
				</Text>
				<Button size="xs" onClick={onUpgrade}>
					{t`See upgrade options`}
				</Button>
			</Stack>
		</Alert>
	);
}
