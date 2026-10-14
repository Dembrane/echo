import { Trans } from "@lingui/react/macro";
import { Stack, Text } from "@mantine/core";
import { Logo } from "@/components/common/Logo";

export const VerifyArtefactLoading = () => {
	return (
		<Stack justify="center" gap="xl" className="h-full">
			<div className="animate-spin self-start">
				<Logo hideTitle hideEnvBadge alwaysDembrane h="48px" />
			</div>
			<Stack gap="sm">
				<Text size="xl">
					<Trans id="participant.concrete.loading.artefact">
						Loading artefact
					</Trans>
				</Text>
				<Text size="sm" c="dimmed">
					<Trans id="participant.concrete.loading.artefact.description">
						This will just take a moment
					</Trans>
				</Text>
			</Stack>
		</Stack>
	);
};
