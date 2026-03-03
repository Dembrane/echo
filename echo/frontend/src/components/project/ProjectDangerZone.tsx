import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Button,
	Group,
	Modal,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconCopy, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { analytics } from "@/lib/analytics";
import { AnalyticsEvents as events } from "@/lib/analyticsEvents";
import { testId } from "@/lib/testUtils";
import { ExponentialProgress } from "../common/ExponentialProgress";
import {
	useCloneProjectByIdMutation,
	useDeleteProjectByIdMutation,
} from "./hooks";
import { ProjectSettingsSection } from "./ProjectSettingsSection";

export const ProjectDangerZone = ({ project }: { project: Project }) => {
	const deleteProjectByIdMutation = useDeleteProjectByIdMutation();
	const cloneProjectByIdMutation = useCloneProjectByIdMutation();
	const navigate = useI18nNavigate();

	const [isCloneModalOpen, { open: openCloneModal, close: closeCloneModal }] =
		useDisclosure(false);

	const [
		isDeleteModalOpen,
		{ open: openDeleteModal, close: closeDeleteModal },
	] = useDisclosure(false);

	const [cloneName, setCloneName] = useState(project.name ?? "");

	const handleClone = async () => {
		try {
			analytics.trackEvent(events.CLONE_PROJECT);
		} catch (error) {
			console.warn("Analytics tracking failed:", error);
		}

		try {
			const newProjectId = await cloneProjectByIdMutation.mutateAsync({
				id: project.id,
				payload: {
					language: project.language ?? "en",
					name: cloneName.trim() ? cloneName : undefined,
				},
			});

			if (newProjectId) {
				navigate(`/projects/${newProjectId}`);
			}
		} catch (_error) {
			// toast handled in mutation hook
		}
	};

	const handleDelete = () => {
		if (
			window.confirm(
				t`By deleting this project, you will delete all the data associated with it. This action cannot be undone. Are you ABSOLUTELY sure you want to delete this project?`,
			)
		) {
			try {
				analytics.trackEvent(events.DELETE_PROJECT);
			} catch (error) {
				console.warn("Analytics tracking failed:", error);
			}
			deleteProjectByIdMutation.mutate(project.id);
			navigate("/projects");
		}
	};

	return (
		<ProjectSettingsSection
			title={<Trans>Actions</Trans>}
			variant="danger"
			align="start"
			{...testId("project-actions-section")}
		>
			<Stack maw="300px">
				<Button
					onClick={openCloneModal}
					variant="outline"
					rightSection={<IconCopy />}
					loading={cloneProjectByIdMutation.isPending}
					{...testId("project-actions-clone-button")}
				>
					<Trans>Clone Project</Trans>
				</Button>

				<Button
					onClick={openDeleteModal}
					color="red"
					variant="outline"
					rightSection={<IconTrash />}
					{...testId("project-actions-delete-button")}
				>
					<Trans>Delete Project</Trans>
				</Button>
			</Stack>
			<Modal
				opened={isCloneModalOpen}
				onClose={closeCloneModal}
				title={<Trans>Clone Project</Trans>}
				{...testId("project-clone-modal")}
			>
				<Stack gap="md">
					<Text size="sm">
						<Trans>
							This will create a copy of the current project. Only settings and
							tags are copied. Reports, chats and conversations are not included
							in the clone. You will be redirected to the new project after
							cloning.
						</Trans>
					</Text>

					{cloneProjectByIdMutation.isPending && (
						<ExponentialProgress expectedDuration={30} isLoading={true} />
					)}

					{!cloneProjectByIdMutation.isPending &&
						cloneProjectByIdMutation.error && (
							<Alert
								title={t`Error cloning project`}
								color="red"
								variant="light"
							>
								<Trans>
									There was an error cloning your project. Please try again or
									contact support.
								</Trans>
							</Alert>
						)}

					<TextInput
						label={<Trans>Project name</Trans>}
						placeholder={t`Enter a name for your cloned project`}
						value={cloneName}
						onChange={(event) => setCloneName(event.currentTarget.value)}
						{...testId("project-clone-name-input")}
					/>
					<Group justify="flex-end">
						<Button
							variant="subtle"
							onClick={closeCloneModal}
							{...testId("project-clone-cancel-button")}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button
							onClick={handleClone}
							loading={cloneProjectByIdMutation.isPending}
							{...testId("project-clone-confirm-button")}
						>
							<Trans>Clone project</Trans>
						</Button>
					</Group>
				</Stack>
			</Modal>
			<Modal
				opened={isDeleteModalOpen}
				onClose={closeDeleteModal}
				title={<Trans>Delete Project</Trans>}
				{...testId("project-delete-modal")}
			>
				<Stack gap="md">
					<Text size="sm">
						<Trans>
							Are you sure you want to delete this project? This action cannot
							be undone.
						</Trans>
					</Text>
				</Stack>
				<Group justify="flex-end">
					<Button
						variant="subtle"
						onClick={closeDeleteModal}
						{...testId("project-delete-cancel-button")}
					>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						onClick={handleDelete}
						loading={deleteProjectByIdMutation.isPending}
						{...testId("project-delete-confirm-button")}
					>
						<Trans>Delete Project</Trans>
					</Button>
				</Group>
			</Modal>
		</ProjectSettingsSection>
	);
};
