import { Trans } from "@lingui/react/macro";
import { Anchor, Button, Group, Paper, Stack, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { I18nLink } from "@/components/common/i18nLink";
import { SupportRequestNoteModal } from "@/components/workspace/SupportRequestNoteModal";
import { useSupportVisit } from "@/components/workspace/supportVisit";
import { useWorkspace } from "@/hooks/useWorkspace";

/**
 * Staff self-join a workspace for support (ECHO-863). Only works when the
 * customer has enabled allow_support_access (else the endpoint 403s with a
 * clear message). Access is granted as admin and auto-revokes after 24h.
 * A request, approved by the customer, lets the visit make changes.
 */
export function JoinSupportControl({
	workspaceId,
	workspaceName,
}: {
	workspaceId: string;
	workspaceName: string;
}) {
	const { setWorkspace } = useWorkspace();
	const visit = useSupportVisit(workspaceId);
	const [
		requestModalOpened,
		{ open: openRequestModal, close: closeRequestModal },
	] = useDisclosure(false);

	const {
		active,
		supportEnabled,
		pendingRequest,
		canChange,
		loading,
		busy,
		join: joinMutation,
		leave: leaveMutation,
		cancelRequest: cancelRequestMutation,
	} = visit;
	const endsAt = ((iso: string | null | undefined): string => {
		if (!iso) return "";
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return "";
		return d.toLocaleString(undefined, {
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			month: "short",
		});
	})(visit.expiresAt);

	return (
		<Paper withBorder p="sm">
			<Stack gap="xs">
				<Text size="sm">
					<Trans>Join for support</Trans>
				</Text>
				{active ? (
					<Text size="xs">
						<Trans>
							You have support access to this workspace. It ends automatically
							on {endsAt}.
						</Trans>
					</Text>
				) : (
					<Text size="xs">
						<Trans>
							Join this workspace as an admin to help with support. The customer
							must have turned on staff support access. Your access ends
							automatically after 24 hours.
						</Trans>
					</Text>
				)}
				<Group justify="flex-start" gap="sm">
					{supportEnabled && (
						<Button
							size="xs"
							loading={joinMutation.isPending}
							disabled={busy || visit.visitLoading}
							onClick={() => joinMutation.mutate()}
						>
							{active ? (
								<Trans>Extend 24h</Trans>
							) : (
								<Trans>Join for support (24h)</Trans>
							)}
						</Button>
					)}
					{active && (
						<>
							<Button
								size="xs"
								loading={leaveMutation.isPending}
								disabled={busy}
								onClick={() => leaveMutation.mutate()}
							>
								<Trans>Leave now</Trans>
							</Button>
							<Anchor
								component={I18nLink}
								to={`/w/${workspaceId}/home`}
								size="xs"
								onClick={() => setWorkspace(workspaceId)}
							>
								<Trans>Open workspace</Trans>
							</Anchor>
						</>
					)}
					{/* Asking is how a read-only visit gets to make changes, so it is offered
					    whenever the visit cannot change anything yet. */}
					{!loading && !canChange && pendingRequest && (
						<>
							<Text size="xs">
								<Trans>Request sent. Waiting for the workspace admins.</Trans>
							</Text>
							<Button
								size="xs"
								variant="subtle"
								color="gray"
								loading={cancelRequestMutation.isPending}
								disabled={busy}
								onClick={() => cancelRequestMutation.mutate()}
							>
								<Trans>Cancel request</Trans>
							</Button>
						</>
					)}
					{!loading && !canChange && !pendingRequest && (
						<Button size="xs" disabled={busy} onClick={openRequestModal}>
							<Trans>Request access</Trans>
						</Button>
					)}
				</Group>
			</Stack>
			<SupportRequestNoteModal
				opened={requestModalOpened}
				onClose={closeRequestModal}
				visit={visit}
				workspaceName={workspaceName}
			/>
		</Paper>
	);
}
