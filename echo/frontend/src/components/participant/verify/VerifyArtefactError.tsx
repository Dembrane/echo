import { Trans } from "@lingui/react/macro";
import { Button, Stack, Text } from "@mantine/core";
import { IconArrowLeft, IconReload } from "@tabler/icons-react";

interface VerifyArtefactErrorProps {
	onReload: () => void;
	onGoBack: () => void;
	isReloading: boolean;
}

export const VerifyArtefactError = ({
	onReload,
	onGoBack,
	isReloading,
}: VerifyArtefactErrorProps) => {
	return (
		<Stack align="center" justify="center" gap="lg" className="h-full px-4">
			<Text size="xl" fw={500} c="red" mb="md">
				<Trans id="participant.outcome.error.title">
					Unable to Load Outcome
				</Trans>
			</Text>
			<Text size="md" c="dimmed" mb="lg" ta="center">
				<Trans id="participant.outcome.error.description">
					It looks like we couldn't load this outcome. This might be a temporary
					issue. You can try reloading or go back to select a different topic.
				</Trans>
			</Text>
			<Stack gap="xl" className="w-full max-w-xs">
				<Button
					variant="light"
					size="md"
					radius="md"
					onClick={onReload}
					loading={isReloading}
					disabled={isReloading}
					leftSection={!isReloading && <IconReload />}
				>
					<Trans id="participant.concrete.artefact.action.button.reload">
						Reload Page
					</Trans>
				</Button>
				<Button
					variant="filled"
					size="md"
					radius="md"
					leftSection={<IconArrowLeft size={16} />}
					onClick={onGoBack}
					disabled={isReloading}
				>
					<Trans id="participant.concrete.artefact.action.button.go.back">
						Go back
					</Trans>
				</Button>
			</Stack>
		</Stack>
	);
};
