import { Trans } from "@lingui/react/macro";
import { Alert, Button, Container, Group, Stack } from "@mantine/core";
import { WarningCircleIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

interface FetchErrorPanelProps {
	onRetry: () => void;
	message: ReactNode;
	/** Server-provided string that overrides `message` when truthy. */
	detail?: string | null;
	/** The way back, when the page has one: Back in the left corner, Try again in the right. */
	onBack?: () => void;
	testId?: string;
}

// Counterpart to AccessDeniedPanel: for 401/403/404 use that instead.
export function FetchErrorPanel({
	onRetry,
	message,
	detail,
	onBack,
	testId = "fetch-error-panel",
}: FetchErrorPanelProps) {
	return (
		<Container size="sm" py="xl" data-testid={testId}>
			<Stack gap="md" mt="20vh" maw={440} mx="auto">
				<Alert color="red" icon={<WarningCircleIcon size={20} />} w="100%">
					{detail ?? message}
				</Alert>
				{/* Alone, Try again sits at the left. With a Back beside it the two take
				    the corners (rules.css). */}
				{onBack ? (
					<Group data-steps justify="space-between" gap="sm">
						<Button variant="subtle" color="gray" onClick={onBack}>
							<Trans>Back</Trans>
						</Button>
						<Button
							variant="filled"
							onClick={onRetry}
							data-testid={`${testId}-retry-button`}
						>
							<Trans>Try again</Trans>
						</Button>
					</Group>
				) : (
					<Group gap="sm">
						<Button
							variant="filled"
							onClick={onRetry}
							data-testid={`${testId}-retry-button`}
						>
							<Trans>Try again</Trans>
						</Button>
					</Group>
				)}
			</Stack>
		</Container>
	);
}
