import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, Select, Stack, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconArrowRight } from "@tabler/icons-react";
import posthog from "posthog-js";
import { useMemo, useState } from "react";
import { useParams } from "react-router";
import { ConfirmModal } from "@/components/common/ConfirmModal";
import {
	MoveHistory,
	type MoveHistoryEntry,
} from "@/components/common/MoveHistory";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useWorkspace } from "@/hooks/useWorkspace";
import { testId } from "@/lib/testUtils";
import { useMoveProjectMutation } from "./hooks";
import { ProjectSettingsSection } from "./ProjectSettingsSection";

export const ProjectMoveWorkspace = ({ project }: { project: Project }) => {
	const { workspaces, setWorkspace } = useWorkspace();
	const { workspaceId } = useParams();
	const moveProjectMutation = useMoveProjectMutation();
	const navigate = useI18nNavigate();

	const [targetWorkspaceId, setTargetWorkspaceId] = useState<string | null>(
		null,
	);
	const [isConfirmOpen, { open: openConfirm, close: closeConfirm }] =
		useDisclosure(false);

	// Only workspaces the user administers can receive a project, the current
	// one is never a target, AND the move must stay within one billing /
	// data-ownership context (ISSUE-033): internal workspaces of the same org
	// share the org context; an external (bills_separately) workspace is its own
	// context, so its projects can't move out. The backend enforces all three;
	// filtering here keeps the picker from offering moves that would 403.
	const currentWorkspaceId = project.workspace_id ?? workspaceId ?? null;
	const options = useMemo(() => {
		// Context key mirrors billing_service._billing_context_key.
		const contextKey = (w: (typeof workspaces)[number]) =>
			w.bills_separately ? `ws:${w.id}` : `org:${w.org_id}`;
		const sourceWs = workspaces.find((w) => w.id === currentWorkspaceId);
		// Orphaned project (no source workspace) has no context to violate.
		const sourceKey = sourceWs ? contextKey(sourceWs) : null;
		return workspaces
			.filter(
				(w) =>
					(w.role === "admin" || w.role === "owner") &&
					w.id !== currentWorkspaceId &&
					(sourceKey === null || contextKey(w) === sourceKey),
			)
			.map((w) => ({ label: w.name, value: w.id }));
	}, [workspaces, currentWorkspaceId]);

	const targetWorkspaceName = workspaces.find(
		(w) => w.id === targetWorkspaceId,
	)?.name;

	// Moving requires admin/owner on the source workspace (the backend
	// enforces this and would 403 a member). Hide the section entirely for
	// non-admins so they never see an action they can't complete. Orphaned
	// projects (no workspace_id) skip the gate; the backend falls back to an
	// ownership check there.
	const sourceRole = workspaces.find((w) => w.id === currentWorkspaceId)?.role;
	const canMove =
		!project.workspace_id || sourceRole === "admin" || sourceRole === "owner";
	if (!canMove) return null;

	const handleMove = async () => {
		if (!targetWorkspaceId) return;
		posthog.capture("project_moved", { source: "project_settings" });
		try {
			await moveProjectMutation.mutateAsync({
				projectId: project.id,
				targetWorkspaceId,
			});
			closeConfirm();
			// Switch the active workspace so the nav and routing follow the
			// project to its new home, then land on the project there.
			setWorkspace(targetWorkspaceId);
			navigate(`/w/${targetWorkspaceId}/projects/${project.id}/home`);
		} catch (_error) {
			// toast handled in mutation hook
		}
	};

	return (
		<ProjectSettingsSection
			title={<Trans>Move to another workspace</Trans>}
			description={
				<Trans>
					Move this project, with its conversations and reports, into a
					workspace you administer. You need to be an admin or owner of the
					destination workspace.
				</Trans>
			}
			align="start"
			{...testId("project-move-workspace-section")}
		>
			{options.length === 0 ? (
				<Text size="sm">
					<Trans>
						There are no other workspaces you can move this project into.
					</Trans>
				</Text>
			) : (
				<Stack gap="md" maw="320px" w="100%">
					<Select
						label={<Trans>Destination workspace</Trans>}
						placeholder={t`Select a workspace`}
						data={options}
						value={targetWorkspaceId}
						onChange={setTargetWorkspaceId}
						searchable
						{...testId("project-move-workspace-select")}
					/>
					<Button
						onClick={openConfirm}
						disabled={!targetWorkspaceId}
						rightSection={<IconArrowRight />}
						{...testId("project-move-workspace-button")}
					>
						<Trans>Move project</Trans>
					</Button>
				</Stack>
			)}
			<MoveHistory
				entries={
					(project as { move_history?: MoveHistoryEntry[] }).move_history
				}
				title={<Trans>Move history</Trans>}
			/>
			<ConfirmModal
				opened={isConfirmOpen}
				onClose={closeConfirm}
				title={t`Move project`}
				data-testid="project-move-workspace-modal"
				message={
					targetWorkspaceName
						? t`Move "${project.name ?? "this project"}" to ${targetWorkspaceName}? Members of the current workspace will lose access.`
						: t`Move this project to the selected workspace?`
				}
				confirmLabel={<Trans>Move project</Trans>}
				loading={moveProjectMutation.isPending}
				onConfirm={handleMove}
			/>
		</ProjectSettingsSection>
	);
};
