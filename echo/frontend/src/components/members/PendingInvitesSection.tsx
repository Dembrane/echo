import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Alert,
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
import { IconLink, IconRefresh, IconX } from "@tabler/icons-react";
import { useState } from "react";
import { ConfirmModal } from "@/components/common/ConfirmModal";
import { toast } from "@/components/common/Toaster";
import { displayRole } from "@/lib/roles";
import {
	type PendingInvite,
	usePendingInvites,
	useResendInvite,
	useRevokeInvite,
} from "./hooks";

interface Props {
	orgId: string;
	// "org" → both org-only and workspace-typed rows; "workspace" → only workspace-typed rows for `workspaceId`.
	scope: "org" | "workspace";
	workspaceId?: string;
}

// Pending invites list with per-row Resend/Revoke. Hides itself when empty.
export function PendingInvitesSection({ orgId, scope, workspaceId }: Props) {
	const isWorkspaceScope = scope === "workspace";
	const {
		data: invites = [],
		isLoading,
		isError,
		error,
	} = usePendingInvites({
		enabled: !isWorkspaceScope || Boolean(workspaceId),
		orgId,
		workspaceId: isWorkspaceScope ? workspaceId : undefined,
	});

	const resend = useResendInvite({
		orgId,
		workspaceId: isWorkspaceScope ? workspaceId : undefined,
	});
	const revoke = useRevokeInvite({
		orgId,
		workspaceId: isWorkspaceScope ? workspaceId : undefined,
	});
	const posthog = usePostHog();

	const [confirmOpened, { open: openConfirm, close: closeConfirm }] =
		useDisclosure(false);
	const [pendingRevoke, setPendingRevoke] = useState<PendingInvite | null>(null);

	if (isLoading) return null;
	if (isError) {
		return (
			<Box mt="xl">
				<Alert color="red" variant="light">
					{error instanceof Error
						? error.message
						: t`Couldn't load pending invites.`}
				</Alert>
			</Box>
		);
	}
	if (invites.length === 0) return null;

	const handleCopyLink = (inv: PendingInvite) => {
		if (!inv.invite_url) return;
		void navigator.clipboard.writeText(inv.invite_url).then(
			() => {
				toast.success(t`Link copied`);
				posthog?.capture("invite_link_copied", {
					source: "pending_list",
					type: inv.type,
				});
			},
			() => toast.error(t`Couldn't copy the link.`),
		);
	};

	const handleResend = (inv: PendingInvite) => {
		resend.mutate(inv.id, {
			onError: (err) => toast.error(err.message),
			onSuccess: (data) => {
				if (data.email_sent) {
					toast.success(t`Invite resent`);
				} else {
					toast.error(
						t`Could not send the invite email. Check email configuration.`,
					);
				}
			},
		});
	};

	const handleRevoke = (inv: PendingInvite) => {
		setPendingRevoke(inv);
		openConfirm();
	};

	const confirmRevoke = () => {
		if (!pendingRevoke) return;
		const inv = pendingRevoke;
		revoke.mutate(inv.id, {
			onError: (err) => toast.error(err.message),
			onSuccess: () => toast.success(t`Invite revoked`),
		});
		closeConfirm();
		setPendingRevoke(null);
	};

	return (
		<Box mt="xl" data-testid="pending-invites-section">
			<Divider />
			<Stack gap={12} my="lg">
				<Title order={5} fw={400}>
					<Trans>Pending invites</Trans>
				</Title>
				<Stack gap="xs">
					{invites.map((inv) => (
						<Paper key={inv.id} p="md" withBorder radius="md">
							<Group justify="space-between" wrap="nowrap">
								<Box style={{ minWidth: 0 }}>
									<Text size="sm" truncate>
										{inv.email}
									</Text>
									<Text size="xs" c="dimmed">
										<span>{displayRole(inv.role)}</span>
										{inv.invited_by_name && (
											<>
												{" · "}
												<Trans>invited by {inv.invited_by_name}</Trans>
											</>
										)}
									</Text>
								</Box>
								<Group gap={8} wrap="nowrap">
									{inv.type === "org" ? (
										<Badge size="xs" variant="light" color="primary">
											<Trans>Org only</Trans>
										</Badge>
									) : (
										inv.workspace_name && (
											<Badge size="xs" variant="light" color="gray">
												{inv.workspace_name}
											</Badge>
										)
									)}
									<Badge size="xs" variant="light" color="yellow">
										<Trans>Pending</Trans>
									</Badge>
									{inv.invite_url && (
										<Tooltip label={t`Copy invite link`}>
											<ActionIcon
												size="sm"
												variant="subtle"
												onClick={() => handleCopyLink(inv)}
												aria-label={t`Copy invite link`}
												data-testid={`pending-invite-copy-link-${inv.id}`}
											>
												<IconLink size={14} />
											</ActionIcon>
										</Tooltip>
									)}
									<Tooltip label={t`Resend invite email`}>
										<ActionIcon
											size="sm"
											variant="subtle"
											loading={resend.isPending && resend.variables === inv.id}
											onClick={() => handleResend(inv)}
											aria-label={t`Resend invite`}
											data-testid={`pending-invite-resend-${inv.id}`}
										>
											<IconRefresh size={14} />
										</ActionIcon>
									</Tooltip>
									<Tooltip label={t`Revoke invite`}>
										<ActionIcon
											size="sm"
											variant="subtle"
											color="gray"
											loading={revoke.isPending && revoke.variables === inv.id}
											onClick={() => handleRevoke(inv)}
											aria-label={t`Revoke invite`}
											data-testid={`pending-invite-revoke-${inv.id}`}
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
					setPendingRevoke(null);
				}}
				onConfirm={confirmRevoke}
				title={t`Revoke invite`}
				message={
					pendingRevoke ? (
						<Trans>
							Revoke the invite sent to {pendingRevoke.email}? You can invite
							them again later.
						</Trans>
					) : (
						""
					)
				}
				confirmLabel={<Trans>Revoke invite</Trans>}
				cancelLabel={<Trans>Keep it</Trans>}
				confirmColor="red"
				data-testid="pending-invite-revoke-confirm"
			/>
		</Box>
	);
}
