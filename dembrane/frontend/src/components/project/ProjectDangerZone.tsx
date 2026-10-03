import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, Group, Modal, Stack, Text, TextInput } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { CopyIcon, TrashIcon } from "@phosphor-icons/react";
import posthog from "posthog-js";
import { useState } from "react";
import { useParams } from "react-router";
import { ConfirmModal } from "@/components/common/ConfirmModal";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useWorkspace } from "@/hooks/useWorkspace";
import { isAdminRole, isOutsiderRole } from "@/lib/roles";
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
	const { workspaceId } = useParams();
	const { workspace } = useWorkspace();
	// Clone needs project:create (no outsiders), delete needs project:delete (admins only).
	const canClone = !!workspace && !isOutsiderRole(workspace.role);
	const canDelete = !!workspace && isAdminRole(workspace.role);

	const [isCloneModalOpen, { open: openCloneModal, close: closeCloneModal }] =
		useDisclosure(false);

	const [
		isDeleteModalOpen,
		{ open: openDeleteModal, close: closeDeleteModal },
	] = useDisclosure(false);

	const [
		isFinalDeleteOpen,
		{ open: openFinalDelete, close: closeFinalDelete },
	] = useDisclosure(false);

	const [cloneName, setCloneName] = useState(project.name ?? "");

	const handleClone = async () => {
		posthog.capture("project_cloned");

		try {
			const newProjectId = await cloneProjectByIdMutation.mutateAsync({
				id: project.id,
				payload: {
					language: project.language ?? "en",
					name: cloneName.trim() ? cloneName : undefined,
				},
			});

			if (newProjectId) {
				navigate(`/w/${workspaceId}/projects/${newProjectId}/home`);
			}
		} catch (_error) {
			// toast handled in mutation hook
		}
	};

	const handleDelete = () => {
		posthog.capture("project_deleted");
		// Leave only once deleted; a refusal keeps the user here (the hook toasts).
		deleteProjectByIdMutation.mutate(project.id, {
			onSuccess: () => navigate(workspaceId ? `/w/${workspaceId}/home` : "/o"),
		});
	};

	if (!canClone && !canDelete) return null;

	return (
		<ProjectSettingsSection
			title={<Trans>Actions</Trans>}
			variant="danger"
			align="start"
			{...testId("project-actions-section")}
		>
			<Stack maw="300px">
				{canClone && (
					<Button
						onClick={openCloneModal}
						leftSection={<CopyIcon size={20} />}
						loading={cloneProjectByIdMutation.isPending}
						{...testId("project-actions-clone-button")}
					>
						<Trans>Clone project</Trans>
					</Button>
				)}

				{canDelete && (
					<Button
						onClick={openDeleteModal}
						color="red"
						leftSection={<TrashIcon size={20} />}
						{...testId("project-actions-delete-button")}
					>
						<Trans>Delete project</Trans>
					</Button>
				)}
			</Stack>
			<Modal
				opened={isCloneModalOpen}
				onClose={closeCloneModal}
				title={<Trans>Clone project</Trans>}
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
							<ErrorNotice
								error={cloneProjectByIdMutation.error}
								title={t`Error cloning project`}
							/>
						)}

					<TextInput
						label={<Trans>Project name</Trans>}
						placeholder={t`Enter a name for your cloned project`}
						value={cloneName}
						onChange={(event) => setCloneName(event.currentTarget.value)}
						{...testId("project-clone-name-input")}
					/>
					{/* 24 from the field to the action that submits it (rule 05). */}
					<Group gap="sm" mt="sm">
						<Button
							variant="filled"
							onClick={handleClone}
							loading={cloneProjectByIdMutation.isPending}
							{...testId("project-clone-confirm-button")}
						>
							<Trans>Clone project</Trans>
						</Button>
						<Button
							variant="subtle"
							color="gray"
							onClick={closeCloneModal}
							{...testId("project-clone-cancel-button")}
						>
							<Trans>Cancel</Trans>
						</Button>
					</Group>
				</Stack>
			</Modal>
			<ConfirmModal
				opened={isDeleteModalOpen}
				onClose={closeDeleteModal}
				title={t`Delete project`}
				data-testid="project-delete-modal"
				message={t`Are you sure you want to delete this project? This action cannot be undone.`}
				confirmLabel={<Trans>Delete</Trans>}
				confirmColor="red"
				onConfirm={() => {
					closeDeleteModal();
					openFinalDelete();
				}}
			/>
			<ConfirmModal
				opened={isFinalDeleteOpen}
				onClose={closeFinalDelete}
				title={t`Delete project`}
				data-testid="project-delete-final-modal"
				message={t`By deleting this project, you will delete all the data associated with it. This action cannot be undone. Are you absolutely sure?`}
				confirmLabel={<Trans>Delete project</Trans>}
				confirmColor="red"
				loading={deleteProjectByIdMutation.isPending}
				onConfirm={handleDelete}
			/>
		</ProjectSettingsSection>
	);
};
