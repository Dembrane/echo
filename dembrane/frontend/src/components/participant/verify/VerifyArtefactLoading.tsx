import { Trans } from "@lingui/react/macro";
import { Skeleton, Stack, Text } from "@mantine/core";

export const VerifyArtefactLoading = () => {
	return (
		<Stack gap="md" className="h-full px-4 pt-10">
			<Stack gap="xs">
				<Text size="md">
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
			<Skeleton height={16} />
			<Skeleton height={16} />
			<Skeleton height={16} />
			<Skeleton height={16} width="70%" />
		</Stack>
	);
};
