import { Trans } from "@lingui/react/macro";
import { Button, Container, Stack, Text, Title } from "@mantine/core";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";

// Shared 401/403/404 panel — replaces the infinite loader (settings)
// and fake empty state (projects) that previously read as "broken."
export function AccessDeniedPanel({
	testId = "access-denied-panel",
}: {
	testId?: string;
} = {}) {
	const navigate = useI18nNavigate();

	return (
		<Container size="sm" py="xl" data-testid={testId}>
			<Stack mt="20vh" gap="md" maw={440} mx="auto">
				<Title order={2}>
					<Trans>You don't have access to this workspace</Trans>
				</Title>
				<Text c="dimmed">
					<Trans>
						Ask a workspace admin for an invite, or pick a different workspace
						from your list.
					</Trans>
				</Text>
				<Button
					variant="filled"
					className="self-start"
					onClick={() => navigate("/o")}
					data-testid={`${testId}-back-button`}
				>
					<Trans>Back to your workspaces</Trans>
				</Button>
			</Stack>
		</Container>
	);
}
