import { Trans } from "@lingui/react/macro";
import { Alert, Button, Container, Group, Stack } from "@mantine/core";
import { WarningCircleIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

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
			<Stack gap="md" mt="20vh" maw={440} mx="auto">
				<Alert color="red" icon={<WarningCircleIcon size={20} />} w="100%">
					{detail ?? message}
				</Alert>
				<Group gap="sm">
					<Button
						variant="filled"
						onClick={onRetry}
						data-testid={`${testId}-retry-button`}
					>
						<Trans>Try again</Trans>
					</Button>
					{secondaryAction && (
						<Button
							variant="subtle"
							color="gray"
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
