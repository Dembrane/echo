import { Trans } from "@lingui/react/macro";
import { Badge, Group, Stack, Switch, Text } from "@mantine/core";
import { ENABLE_CANVAS } from "@/config";
import { testId } from "@/lib/testUtils";
import { useUpdateProjectByIdMutation } from "./hooks";
import { ProjectSettingsSection } from "./ProjectSettingsSection";

// Early-access features a host can opt this project into. Each toggle is
// per project: flipping it here never affects other projects.
export const ProjectExperimentalSection = ({
	project,
}: {
	project: Project;
}) => {
	const updateProjectMutation = useUpdateProjectByIdMutation();

	// The canvas beta also needs the environment flag; without it the
	// backend 404s every canvas API, so hide the whole card.
	if (!ENABLE_CANVAS) return null;

	return (
		<ProjectSettingsSection
			title={<Trans>Experimental</Trans>}
			description={
				<Trans>
					Early features you can try on this project before they are ready for
					everyone.
				</Trans>
			}
		>
			<Switch
				size="md"
				checked={!!project.is_canvas_enabled}
				disabled={updateProjectMutation.isPending}
				onChange={(event) =>
					updateProjectMutation.mutate({
						id: project.id,
						payload: { is_canvas_enabled: event.currentTarget.checked },
					})
				}
				label={
					<Stack gap="0.25rem">
						<Group gap="xs" wrap="nowrap">
							<Text>
								<Trans>Living canvas</Trans>
							</Text>
							<Badge size="sm" variant="light" color="primary">
								<Trans>Beta</Trans>
							</Badge>
						</Group>
						<Text size="sm">
							<Trans>
								A live page in your Library that regenerates while your session
								runs. Early beta: it may change or be removed.
							</Trans>
						</Text>
					</Stack>
				}
				{...testId("project-experimental-canvas-toggle")}
			/>
		</ProjectSettingsSection>
	);
};
