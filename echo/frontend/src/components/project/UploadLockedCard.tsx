import { Trans } from "@lingui/react/macro";
import { Badge, Box, Stack, Text } from "@mantine/core";
import { IconLock } from "@tabler/icons-react";
import { useState } from "react";
import { UpgradeModal, type Tier } from "@/components/workspace/FeatureGate";
import { useWorkspace } from "@/hooks/useWorkspace";
import { emitFrozenFeatureAttempt } from "@/lib/frozenFeatureAttempt";
import { testId } from "@/lib/testUtils";

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

	const openModal = () => {
		emitFrozenFeatureAttempt();
		setModalOpen(true);
	};

	return (
		<>
			<Box
				onClick={openModal}
				style={{
					alignItems: "center",
					background:
						"repeating-linear-gradient(45deg, rgba(65,105,225,0.04) 0 8px, rgba(65,105,225,0.08) 8px 16px)",
					borderRadius: 8,
					cursor: "pointer",
					display: "flex",
					justifyContent: "center",
					minHeight: 160,
				}}
				role="button"
				tabIndex={0}
				aria-label="Upload locked, workspace at cap"
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						openModal();
					}
				}}
				{...testId("upload-locked-card")}
			>
				<Stack gap={6} align="center" style={{ maxWidth: 280 }} p="md">
					<Badge
						color="blue"
						variant="light"
						leftSection={<IconLock size={12} />}
					>
						<Trans>Upload locked</Trans>
					</Badge>
					<Text size="sm" ta="center" c="dimmed">
						<Trans>
							This workspace has reached its recording cap. Upgrade to
							upload more audio.
						</Trans>
					</Text>
				</Stack>
			</Box>
			<UpgradeModal
				opened={modalOpen}
				onClose={() => setModalOpen(false)}
				currentTier={currentTier}
				requiredTier={requiredTier}
				featureName="Audio upload"
				benefit="Upload recordings once your workspace is upgraded."
				canRequestUpgrade={canRequestUpgrade}
				workspaceId={workspaceId}
			/>
		</>
	);
}
