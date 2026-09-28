import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Badge,
	Box,
	Divider,
	Group,
	Paper,
	Stack,
	Text,
	Title,
	Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { usePostHog } from "@posthog/react";
import { IconCheck, IconX } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ConfirmModal } from "@/components/common/ConfirmModal";
import { toast } from "@/components/common/Toaster";
import { API_BASE_URL } from "@/config";

interface AccessRequestRow {
	id: string;
	workspace_id: string;
	user_id: string;
	user_display_name: string | null;
	user_email: string | null;
	status: string;
	requested_at: string;
}

async function fetchRequests(workspaceId: string): Promise<AccessRequestRow[]> {
	const res = await fetch(
		`${API_BASE_URL}/v2/workspaces/${workspaceId}/access-requests`,
		{ credentials: "include" },
	);
	if (!res.ok) return [];
	const data = await res.json();
	return data.requests ?? [];
}

async function postAction(
	workspaceId: string,
	reqId: string,
	action: "approve" | "reject",
) {
	const res = await fetch(
		`${API_BASE_URL}/v2/workspaces/${workspaceId}/access-requests/${reqId}/${action}`,
		{ credentials: "include", method: "POST" },
	);
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(data.detail || `Couldn't ${action}`);
	}
	return res.json();
}

/**
 * Pending access-requests list on the workspace settings page (matrix §6).
 *
 * Shows organisation-member requests-to-join that need admin approval. Hides
 * itself when there are no pending rows — no empty-state clutter next
 * to the members table. Approve writes a direct Member row; Reject is
 * silent to the requester.
 */
export const AccessRequestsList = ({
	workspaceId,
	actionedByRole,
}: {
	workspaceId: string;
	actionedByRole: string;
}) => {
	const queryClient = useQueryClient();
	const posthog = usePostHog();

	const { data } = useQuery({
		queryFn: () => fetchRequests(workspaceId),
		queryKey: ["v2", "access-requests", workspaceId],
		staleTime: 15_000,
	});

	const rows = data ?? [];

	const invalidateAll = () => {
		queryClient.invalidateQueries({
			queryKey: ["v2", "access-requests", workspaceId],
		});
		queryClient.invalidateQueries({
			queryKey: ["v2", "workspace-settings", workspaceId],
		});
		queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] });
	};

	const approveMutation = useMutation({
		mutationFn: (reqId: string) => postAction(workspaceId, reqId, "approve"),
		onError: (e: Error) => toast.error(e.message),
		onSuccess: (_data, reqId) => {
			posthog?.capture("workspace_access_actioned", {
				action: "approved",
				actioned_by_role: actionedByRole,
				request_id: reqId,
			});
			toast.success(t`Request approved`);
			invalidateAll();
		},
	});

	const rejectMutation = useMutation({
		mutationFn: (reqId: string) => postAction(workspaceId, reqId, "reject"),
		onError: (e: Error) => toast.error(e.message),
		onSuccess: (_data, reqId) => {
			posthog?.capture("workspace_access_actioned", {
				action: "rejected",
				actioned_by_role: actionedByRole,
				request_id: reqId,
			});
			toast.success(t`Request declined`);
			invalidateAll();
		},
	});

	const [confirmOpened, { open: openConfirm, close: closeConfirm }] =
		useDisclosure(false);
	const [pendingRejectId, setPendingRejectId] = useState<string | null>(null);

	const confirmReject = () => {
		if (!pendingRejectId) return;
		rejectMutation.mutate(pendingRejectId);
		closeConfirm();
		setPendingRejectId(null);
	};

	if (rows.length === 0) return null;

	return (
		<Box mt="xl">
			<Divider />
			<Stack gap={12} my="lg">
				<Title order={5} fw={400}>
					<Trans>Access requests</Trans>
				</Title>
				<Stack gap={0}>
					{rows.map((r) => (
						<Paper key={r.id} p="sm" withBorder radius={0}>
							<Group justify="space-between" wrap="nowrap">
								<Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
									<Text size="sm" lineClamp={1}>
										{r.user_display_name ||
											r.user_email ||
											t`Organisation member`}
									</Text>
									{r.user_email && r.user_display_name && (
										<Tooltip label={r.user_email}>
											<Text size="xs" c="dimmed" style={{ cursor: "default" }}>
												·
											</Text>
										</Tooltip>
									)}
									<Badge size="xs" variant="light" color="yellow">
										<Trans>Pending</Trans>
									</Badge>
								</Group>
								<Group gap={4}>
									<Tooltip label={t`Approve`}>
										<ActionIcon
											color="primary"
											size="sm"
											variant="subtle"
											loading={
												approveMutation.isPending &&
												approveMutation.variables === r.id
											}
											onClick={() => approveMutation.mutate(r.id)}
											aria-label={t`Approve`}
										>
											<IconCheck size={14} />
										</ActionIcon>
									</Tooltip>
									<Tooltip label={t`Decline`}>
										<ActionIcon
											color="gray"
											size="sm"
											variant="subtle"
											loading={
												rejectMutation.isPending &&
												rejectMutation.variables === r.id
											}
											onClick={() => {
												setPendingRejectId(r.id);
												openConfirm();
											}}
											aria-label={t`Decline`}
										>
											<IconX size={14} />
										</ActionIcon>
									</Tooltip>
								</Group>
							</Group>
						</Paper>
					))}
				</Stack>
			</Stack>
			<ConfirmModal
				opened={confirmOpened}
				onClose={() => {
					closeConfirm();
					setPendingRejectId(null);
				}}
				onConfirm={confirmReject}
				title={t`Decline request?`}
				message={
					<Trans>
						Decline this access request? The requester won't be notified and
						would need to request access again.
					</Trans>
				}
				confirmLabel={<Trans>Decline request</Trans>}
				cancelLabel={<Trans>Keep pending</Trans>}
				confirmColor="red"
				data-testid="access-request-reject-confirm"
			/>
		</Box>
	);
};
