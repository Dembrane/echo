import { Trans } from "@lingui/react/macro";
import { Stack, Text } from "@mantine/core";
import { Logo } from "@/components/common/Logo";

export const VerifyArtefactLoading = () => {
	return (
		<Stack align="center" justify="center" gap="xl" className="h-full">
			<div className="animate-spin">
				<Logo hideTitle alwaysDembrane h="48px" />
			</div>
			<Stack gap="sm" align="center">
				<Text size="xl" fw={600}>
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
