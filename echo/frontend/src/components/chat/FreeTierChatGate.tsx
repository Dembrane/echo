import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Badge, Box, Button, Stack, Text } from "@mantine/core";
import { IconLock } from "@tabler/icons-react";
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
	// UpgradeModal resolves the workspace from context itself; we read it here
	// only for the tier/role it needs as props.
	const { workspace } = useWorkspace();
	const isChatLimit = reason === "chats";
	return (
		<UpgradeModal
			opened={opened}
			onClose={onClose}
			currentTier={(workspace?.tier ?? "free") as Tier}
			requiredTier={UPGRADE_TIER}
			featureName={isChatLimit ? t`Chats` : t`Chat messages`}
			benefit={
				isChatLimit
					? t`Upgrade your plan to start more chats in this workspace.`
					: t`Upgrade your plan to keep chatting in this workspace.`
			}
			canRequestUpgrade={
				workspace?.role === "admin" || workspace?.role === "owner"
			}
			workspaceId={workspace?.id ?? ""}
		/>
	);
}

/**
 * Inline card rendered in the chat thread in place of the 4th turn's reply.
 * Clicking it opens the upgrade path.
 */
export function ChatTurnLimitCard({ onUpgrade }: { onUpgrade: () => void }) {
	return (
		<Box
			style={{
				background:
					"repeating-linear-gradient(45deg, color-mix(in srgb, var(--mantine-color-primary-6) 4%, transparent) 0 8px, color-mix(in srgb, var(--mantine-color-primary-6) 8%, transparent) 8px 16px)",
				borderRadius: 8,
			}}
			p="md"
		>
			<Stack gap="xs" align="flex-start">
				<Badge color="primary" variant="light" leftSection={<IconLock size={12} />}>
					<Trans>Upgrade to continue</Trans>
				</Badge>
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
		</Box>
	);
}
