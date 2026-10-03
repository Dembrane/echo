import { Trans } from "@lingui/react/macro";
import { Skeleton, Stack, Text, Title } from "@mantine/core";
import { useOrgTrainingRoster } from "./hooks";
import { TrainingRoster } from "./TrainingRoster";

interface WorkspaceTrainingPanelProps {
	orgId: string;
}

/**
 * Workspace-admin training-verification view (ISSUE-020, both-sides
 * visibility). A workspace admin sees how many of their org's members are
 * trained vs not. Licenses are org-scoped (the org's compliance record), so
 * this reuses the org roster. Read-only here: requesting/provisioning lives in
 * the org Training view and the staff dashboard.
 */
export const WorkspaceTrainingPanel = ({
	orgId,
}: WorkspaceTrainingPanelProps) => {
	const { data: roster, isLoading } = useOrgTrainingRoster(orgId);

	if (isLoading) {
		return (
			<Stack gap="sm">
				<Skeleton height={24} width="40%" />
				<Skeleton height={16} width="70%" />
				<Skeleton height={120} />
			</Stack>
		);
	}
	if (!roster) {
		return (
			<Text size="sm" c="dimmed">
				<Trans>Training verification isn't available here.</Trans>
			</Text>
		);
	}

	return (
		<Stack gap="md">
			<div>
				<Title order={4}>
					<Trans>Training</Trans>
				</Title>
				<Text size="sm" c="dimmed">
					<Trans>
						Who on your team holds a current training license. Book a training
						from your organisation's Training view.
					</Trans>
				</Text>
			</div>
			<Text size="sm">
				<Trans>
					{roster.trained_count} of {roster.total_count} members are trained.
				</Trans>
			</Text>
			<TrainingRoster members={roster.members} showEmails={roster.can_manage} />
		</Stack>
	);
};
