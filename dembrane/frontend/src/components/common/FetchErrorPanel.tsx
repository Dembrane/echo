import { Trans } from "@lingui/react/macro";
import { Alert, Button, Container, Group, Stack } from "@mantine/core";
import { type ReactNode } from "react";

interface FetchErrorPanelProps {
	onRetry: () => void;
	message: ReactNode;
	/** Server-provided string that overrides `message` when truthy. */
	detail?: string | null;
	secondaryAction?: { label: ReactNode; onClick: () => void };
	testId?: string;
}

// Counterpart to AccessDeniedPanel — for 401/403/404 use that instead.
export function FetchErrorPanel({
	onRetry,
	message,
	detail,
	secondaryAction,
	testId = "fetch-error-panel",
}: FetchErrorPanelProps) {
	return (
		<Container size="sm" py="xl" data-testid={testId}>
			<Stack align="center" gap="md" mt="20vh" maw={420} mx="auto">
				<Alert color="red" variant="light" w="100%">
					{detail ?? message}
				</Alert>
				<Group>
					<Button
						variant="default"
						size="sm"
						onClick={onRetry}
						data-testid={`${testId}-retry-button`}
					>
						<Trans>Retry</Trans>
					</Button>
					{secondaryAction && (
						<Button
							variant="subtle"
							size="sm"
							onClick={secondaryAction.onClick}
						>
							{secondaryAction.label}
						</Button>
					)}
				</Group>
			</Stack>
		</Container>
	);
}
