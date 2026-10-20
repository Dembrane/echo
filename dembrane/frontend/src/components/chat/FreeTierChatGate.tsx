import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Alert, Button, Stack, Text } from "@mantine/core";
import { LockIcon } from "@phosphor-icons/react";
import { UpgradeModal } from "@/components/workspace/FeatureGate";
import { useWorkspace } from "@/hooks/useWorkspace";
import type { FreeTierLimit } from "@/lib/freeTier";
import type { Tier } from "@/lib/tiers";

// The single purchasable tier today (mirrors backend FREE_TIER_UPGRADE_CTA_TIER).
const UPGRADE_TIER: Tier = "changemaker";

/**
 * Chat-specific wrapper over the shared UpgradeModal. Pulls the current tier
 * and role from workspace context so call sites only manage open/close.
 */
export function ChatUpgradeModal({
	opened,
	onClose,
	reason,
}: {
	opened: boolean;
	onClose: () => void;
	reason: FreeTierLimit;
}) {
	const { workspace } = useWorkspace();
	const isChatLimit = reason === "chats";
	// Only a free limit opens this wall.
	return (
		<UpgradeModal
			opened={opened}
			onClose={onClose}
			currentTier="free"
			requiredTier={null}
			canRequestUpgrade
			workspaceId={workspace?.id ?? ""}
			wallKey={isChatLimit ? "chat_cap" : "chat_turn_cap"}
			entry="modal_direct"
		/>
	);
}

/** The recording-hours cap, reached from the composer's microphone. Separate
 * from ChatUpgradeModal because that copy names a per-chat limit. */
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

/** Inline card in the chat thread once its free turns or the month's chats are used, or it is frozen. */
export function ChatTurnLimitCard({
	onUpgrade,
	frozen,
	monthly,
}: {
	onUpgrade: () => void;
	frozen?: boolean;
	monthly?: boolean;
}) {
	return (
		<Alert
			color="gray"
			icon={<LockIcon size={20} />}
			title={<Trans>Upgrade to continue</Trans>}
		>
			<Stack gap="sm" align="flex-start">
				<Text size="sm">
					{monthly ? (
						<Trans>
							You have used this month's free chats. Upgrade to keep chatting.
						</Trans>
					) : frozen ? (
						<Trans>
							This chat is from an earlier month and is now read-only on the
							free plan. Start a new chat or upgrade to keep going.
						</Trans>
					) : (
						<Trans>
							You've reached the free plan limit for this chat. Upgrade to keep
							the conversation going.
						</Trans>
					)}
				</Text>
				<Button size="xs" onClick={onUpgrade}>
					{t`See upgrade options`}
				</Button>
			</Stack>
		</Alert>
	);
}
