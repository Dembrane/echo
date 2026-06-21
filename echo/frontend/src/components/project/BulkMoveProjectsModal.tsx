import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import { Button, Group, Modal, Select, Stack, Text } from "@mantine/core";
import posthog from "posthog-js";
import { useEffect, useMemo, useState } from "react";
import { useWorkspace } from "@/hooks/useWorkspace";
import { testId } from "@/lib/testUtils";
import { useBulkMoveProjectsMutation } from "./hooks";

interface Props {
	opened: boolean;
	onClose: () => void;
	projectIds: string[];
	/** Workspace the projects currently live in (the source context). */
	sourceWorkspaceId: string;
	/** Called after a successful move so the caller can clear its selection. */
	onMoved: () => void;
}

/**
 * Move several selected projects to one target workspace. Destinations are the
 * workspaces the user administers within the SAME billing / data-ownership
 * context as the source (mirrors the single project move). The server
 * re-enforces admin/owner on both + the context guard.
 */
export const BulkMoveProjectsModal = ({
	opened,
	onClose,
	projectIds,
	sourceWorkspaceId,
	onMoved,
}: Props) => {
	const { workspaces } = useWorkspace();
	const [targetWorkspaceId, setTargetWorkspaceId] = useState<string | null>(null);
	const bulkMove = useBulkMoveProjectsMutation();

	// Same context key as billing_service._billing_context_key: an external
	// (bills_separately) workspace is its own context; internal ones share the org.
	const options = useMemo(() => {
		const contextKey = (w: (typeof workspaces)[number]) =>
			w.bills_separately ? `ws:${w.id}` : `org:${w.org_id}`;
		const source = workspaces.find((w) => w.id === sourceWorkspaceId);
		const sourceKey = source ? contextKey(source) : null;
		return workspaces
			.filter(
				(w) =>
					(w.role === "admin" || w.role === "owner") &&
					w.id !== sourceWorkspaceId &&
					(sourceKey === null || contextKey(w) === sourceKey),
			)
			.map((w) => ({ label: w.name, value: w.id }));
	}, [workspaces, sourceWorkspaceId]);

	useEffect(() => {
		if (!opened) setTargetWorkspaceId(null);
	}, [opened]);

	const handleMove = () => {
		if (!targetWorkspaceId || projectIds.length === 0) return;
		posthog.capture("projects_bulk_moved", { count: projectIds.length });
		bulkMove.mutate(
			{ projectIds, targetWorkspaceId },
			{
				onSuccess: () => {
					onMoved();
					onClose();
				},
			},
		);
	};

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={t`Move projects`}
			{...testId("bulk-move-projects-modal")}
		>
			<Stack gap="lg">
				<Text size="sm">
					<Plural
						value={projectIds.length}
						one="Move # project to another workspace."
						other="Move # projects to another workspace."
					/>
				</Text>
				{options.length === 0 ? (
					<Text size="sm">
						<Trans>
							There are no other workspaces you can move these projects into.
						</Trans>
					</Text>
				) : (
					<Select
						label={<Trans>Destination workspace</Trans>}
						placeholder={t`Select a workspace`}
						data={options}
						value={targetWorkspaceId}
						onChange={setTargetWorkspaceId}
						searchable
						{...testId("bulk-move-projects-select")}
					/>
				)}
				<Group justify="flex-end">
					<Button
						variant="subtle"
						onClick={onClose}
						disabled={bulkMove.isPending}
						{...testId("bulk-move-projects-cancel")}
					>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						onClick={handleMove}
						loading={bulkMove.isPending}
						disabled={!targetWorkspaceId || bulkMove.isPending}
						{...testId("bulk-move-projects-confirm")}
					>
						<Trans>Move</Trans>
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
};
