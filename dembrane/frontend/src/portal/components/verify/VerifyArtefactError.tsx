import { Trans } from "@lingui/react/macro";
import { Button, Group, Stack, Text, Title } from "@mantine/core";
import { ArrowLeftIcon, ArrowsClockwiseIcon } from "@phosphor-icons/react";

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
		<Stack justify="center" gap="md" className="h-full px-4">
			<Title order={2}>
				<Trans id="participant.outcome.error.title">
					Unable to load outcome
				</Trans>
			</Title>
			<Text c="dimmed">
				<Trans id="participant.outcome.error.description">
					It looks like we couldn't load this outcome. This might be a temporary
					issue. You can try reloading or go back to select a different topic.
				</Trans>
			</Text>
			<Group gap="sm">
				<Button
					variant="filled"
					size="md"
					onClick={onReload}
					loading={isReloading}
					disabled={isReloading}
					leftSection={<ArrowsClockwiseIcon size={20} />}
				>
					<Trans id="participant.concrete.artefact.action.button.reload">
						Reload page
					</Trans>
				</Button>
				<Button
					size="md"
					leftSection={<ArrowLeftIcon size={20} />}
					onClick={onGoBack}
					disabled={isReloading}
				>
					<Trans id="participant.concrete.artefact.action.button.go.back">
						Back
					</Trans>
				</Button>
			</Group>
		</Stack>
	);
};
