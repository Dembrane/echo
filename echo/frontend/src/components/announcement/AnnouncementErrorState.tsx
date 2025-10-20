import { Trans } from "@lingui/react/macro";
import { Alert, Box, Button, Stack, Text } from "@mantine/core";
import { IconAlertCircle, IconRefresh } from "@tabler/icons-react";

interface AnnouncementErrorStateProps {
	onRetry: () => void;
	isLoading?: boolean;
}

export const AnnouncementErrorState = ({
	onRetry,
	isLoading = false,
}: AnnouncementErrorStateProps) => {
	return (
		<Box p="md">
			<Alert
				icon={<IconAlertCircle size="1rem" />}
				color="red"
				variant="light"
				title={<Trans>Error loading announcements</Trans>}
			>
				<Stack gap="md">
					<Text size="sm">
						<Trans>Failed to get announcements</Trans>
					</Text>
					<Button
						variant="light"
						color="red"
						size="sm"
						leftSection={<IconRefresh size="1rem" />}
						onClick={onRetry}
						loading={isLoading}
					>
						<Trans>Try Again</Trans>
					</Button>
				</Stack>
			</Alert>
		</Box>
	);
};
