import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Alert, Button, Group, Stack, Text, Tooltip } from "@mantine/core";
import { PauseCircleIcon, UploadSimpleIcon } from "@phosphor-icons/react";
import { usePricingConfigurator } from "@/components/pricing";
import { UpgradeModal } from "@/components/workspace/FeatureGate";
import {
	recordingPaused,
	useProjectRecording,
	useUseForRecordings,
} from "@/hooks/useProjectRecording";
import { testId } from "@/lib/testUtils";
import { SELLABLE_TIER } from "@/lib/tiers";

// Null (caller cannot open it) or empty: a neutral place.
const projectName = (name: string | null) => name?.trim() || t`another project`;

type RecordingPausedNoticeProps = {
	projectId: string;
	workspaceId: string;
};

// On the free plan one project takes recordings; every other project says where they go.
export const RecordingPausedNotice = ({
	projectId,
	workspaceId,
}: RecordingPausedNoticeProps) => {
	const { data } = useProjectRecording(projectId);
	const useForRecordings = useUseForRecordings(projectId);
	const configurator = usePricingConfigurator("recording_project");

	if (!recordingPaused(data)) return null;
	const name = projectName(data.recording_project.name);

	return (
		<Alert
			variant="light"
			color="primary"
			icon={<PauseCircleIcon size={16} />}
			{...testId("recording-paused-notice")}
		>
			<Stack gap="sm">
				<Text size="sm">
					<Trans>
						Recordings are paused for this project on the free plan. New
						recordings go to {name}.
					</Trans>
				</Text>
				<Group gap="xs">
					{data.can_switch && (
						<Button
							size="xs"
							loading={useForRecordings.isPending}
							onClick={() => useForRecordings.mutate()}
							{...testId("recording-paused-notice-switch")}
						>
							<Trans>Use this project for recordings</Trans>
						</Button>
					)}
					<Button
						size="xs"
						variant="subtle"
						onClick={configurator.open}
						{...testId("recording-paused-notice-upgrade")}
					>
						<Trans>Record in every project</Trans>
					</Button>
				</Group>
			</Stack>
			<UpgradeModal
				opened={configurator.opened}
				onClose={configurator.close}
				currentTier="free"
				requiredTier={SELLABLE_TIER}
				canRequestUpgrade
				workspaceId={workspaceId}
				projectId={projectId}
				wallKey="recording_project"
				entry="modal_direct"
			/>
		</Alert>
	);
};

// Stands in for the upload button on a project that does not take recordings.
export const RecordingPausedUploadButton = (props: { name: string | null }) => {
	const name = projectName(props.name);
	return (
		<Tooltip label={t`On the free plan, uploads go to ${name}.`}>
			{/* data-disabled, not disabled: a disabled button never shows its tooltip */}
			<Button
				data-disabled
				aria-disabled
				onClick={(event) => event.preventDefault()}
				leftSection={<UploadSimpleIcon size={20} />}
				{...testId("recording-paused-upload-button")}
			>
				<Trans>Upload</Trans>
			</Button>
		</Tooltip>
	);
};
