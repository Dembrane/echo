import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Badge, Box, Stack, Text } from "@mantine/core";
import { LockIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { UpgradeModal } from "@/components/workspace/FeatureGate";
import { FeatureGatePopover } from "@/components/workspace/FeatureGatePopover";
import { useWorkspace } from "@/hooks/useWorkspace";
import { emitFrozenFeatureAttempt } from "@/lib/frozenFeatureAttempt";
import { testId } from "@/lib/testUtils";
import type { Tier } from "@/lib/tiers";

interface UploadLockedCardProps {
	workspaceId: string;
	upgradeTier: string | null;
}

export function UploadLockedCard({
	workspaceId,
	upgradeTier,
}: UploadLockedCardProps) {
	const [modalOpen, setModalOpen] = useState(false);
	const { workspace } = useWorkspace();
	const currentTier = (workspace?.tier ?? "free") as Tier;
	const requiredTier = (upgradeTier ?? "pioneer") as Tier;
	const canRequestUpgrade =
		workspace?.role === "admin" || workspace?.role === "owner";

	// The frozen feature attempt is the click on the blocked card, not the
	// modal opening: the popover now sits between the two.
	const touched = (open: () => void) => () => {
		emitFrozenFeatureAttempt();
		open();
	};

	return (
		<>
			<FeatureGatePopover
				canRequestUpgrade={canRequestUpgrade}
				onStart={() => setModalOpen(true)}
				requiredTier={requiredTier}
				wallKey="upload_cap"
				workspaceId={workspaceId}
			>
				{({ onClick }) => (
					<Box
						onClick={touched(onClick)}
						className="app-do"
						style={{
							alignItems: "center",
							display: "flex",
							justifyContent: "center",
							minHeight: 160,
						}}
						role="button"
						tabIndex={0}
						aria-label={t`Upload limit reached`}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								touched(onClick)();
							}
						}}
						{...testId("upload-locked-card")}
					>
						<Stack gap="xs" align="center" style={{ maxWidth: 280 }} p="md">
							<Badge
								color="yellow"
								variant="light"
								leftSection={<LockIcon size={16} />}
							>
								<Trans>Upload limit reached</Trans>
							</Badge>
							<Text size="sm" ta="center" c="dimmed">
								<Trans>
									This workspace has reached its recording cap. Upgrade to
									upload more audio.
								</Trans>
							</Text>
						</Stack>
					</Box>
				)}
			</FeatureGatePopover>
			<UpgradeModal
				opened={modalOpen}
				onClose={() => setModalOpen(false)}
				currentTier={currentTier}
				requiredTier={requiredTier}
				canRequestUpgrade={canRequestUpgrade}
				workspaceId={workspaceId}
				wallKey="upload_cap"
				entry="popover_link"
			/>
		</>
	);
}
