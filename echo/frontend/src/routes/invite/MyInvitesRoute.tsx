import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Badge,
	Box,
	Button,
	Container,
	Group,
	Loader,
	Paper,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import { useState } from "react";
import { FetchErrorPanel } from "@/components/common/FetchErrorPanel";
import { toast } from "@/components/common/Toaster";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import {
	useAcceptInvite,
	useDeclineInvite,
	useMyInvites,
} from "@/hooks/useMyInvites";
import { displayRole } from "@/lib/roles";

export const MyInvitesRoute = () => {
	const navigate = useI18nNavigate();
	const { data: invites, isLoading, isError, refetch } = useMyInvites();
	const acceptMutation = useAcceptInvite();
	const declineMutation = useDeclineInvite();
	// Per-invite error map. Toasts are easy to miss — when an accept fails
	// (commonly: the workspace filled up after the invite was sent), we
	// keep an inline yellow alert on that specific card until the user
	// retries or dismisses, so the state is unmissable.
	const [errorByInvite, setErrorByInvite] = useState<Record<string, string>>(
		{},
	);

	useDocumentTitle(t`Pending invites | dembrane`);

	const handleAccept = async (inviteId: string, workspaceName: string) => {
		setErrorByInvite((prev) => {
			const next = { ...prev };
			delete next[inviteId];
			return next;
		});
		try {
			const data = await acceptMutation.mutateAsync(inviteId);
			toast.success(t`Joined ${workspaceName}`);
			navigate(`/w/${data.workspace_id}/home`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Failed to accept";
			setErrorByInvite((prev) => ({ ...prev, [inviteId]: msg }));
			toast.error(msg);
		}
	};

	const handleDecline = (inviteId: string, workspaceName: string) => {
		modals.openConfirmModal({
			children: (
				<Text size="sm">
					<Trans>
						Decline the invite to {workspaceName}? You can ask them to send it
						again later.
					</Trans>
				</Text>
			),
			confirmProps: { color: "red" },
			labels: { cancel: t`Keep it`, confirm: t`Decline` },
			onConfirm: async () => {
				try {
					await declineMutation.mutateAsync(inviteId);
					toast.success(t`Invite declined`);
				} catch (err) {
					toast.error(err instanceof Error ? err.message : "Failed to decline");
				}
			},
			title: t`Decline invite`,
		});
	};

	if (isLoading) {
		return (
			<Container size="sm" py="xl">
				<Stack align="center" mt="20vh">
					<Loader size="sm" color="gray" />
				</Stack>
			</Container>
		);
	}

	// Distinct from the empty-state branch below — a 5xx is not "no invites."
	if (isError) {
		return (
			<FetchErrorPanel
				onRetry={() => refetch()}
				message={
					<Trans>
						We couldn't load your pending invites. Try again in a moment.
					</Trans>
				}
			/>
		);
	}

	if (!invites || invites.length === 0) {
		return (
			<Container size="sm" py="xl" px="lg">
				<Stack gap={24} mt="10vh" align="center">
					<Title order={4} fw={400} c="dimmed">
						<Trans>No pending invites</Trans>
					</Title>
					<Button variant="outline" size="sm" onClick={() => navigate("/w")}>
						<Trans>Back to workspaces</Trans>
					</Button>
				</Stack>
			</Container>
		);
	}

	return (
		<Container size="sm" py="xl" px="lg" pb={80}>
			<Stack gap={24}>
				<Stack gap={4}>
					<Title order={3} fw={400}>
						<Trans>Pending invites</Trans>
					</Title>
					<Text size="sm" c="dimmed">
						<Trans>
							Workspaces you've been invited to join. Accept to start
							collaborating.
						</Trans>
					</Text>
				</Stack>

				<Stack gap={12}>
					{invites.map((inv) => {
						const inviteError = errorByInvite[inv.id];
						return (
							<Paper key={inv.id} p="lg" radius="md" withBorder>
								<Stack gap={16}>
									<Group
										justify="space-between"
										align="flex-start"
										wrap="nowrap"
									>
										<Box flex={1}>
											<Text fw={500} size="md">
												{inv.workspace_name}
											</Text>
											<Text size="xs" c="dimmed" mt={2}>
												{inv.org_name}
											</Text>
											<Group gap={6} mt={8}>
												<Badge size="xs" variant="light" color="gray">
													{displayRole(inv.role)}
												</Badge>
												{inv.invited_by_name && (
													<Text size="xs" c="dimmed">
														<Trans>invited by {inv.invited_by_name}</Trans>
													</Text>
												)}
											</Group>
										</Box>
									</Group>

									{inviteError && (
										<Alert color="yellow" variant="light">
											<Stack gap={4}>
												<Text size="sm" fw={500}>
													<Trans>Couldn't join right now</Trans>
												</Text>
												<Text size="xs">{inviteError}</Text>
												<Text size="xs" c="dimmed">
													<Trans>
														Your invite is still pending. Try again once the
														admin frees a seat or upgrades the workspace.
													</Trans>
												</Text>
											</Stack>
										</Alert>
									)}

									<Group gap={8}>
										<Button
											size="sm"
											variant="default"
											onClick={() => handleDecline(inv.id, inv.workspace_name)}
										>
											<Trans>Decline</Trans>
										</Button>
										<Button
											flex={1}
											size="sm"
											loading={acceptMutation.isPending}
											onClick={() => handleAccept(inv.id, inv.workspace_name)}
										>
											{inviteError ? (
												<Trans>Try again</Trans>
											) : (
												<Trans>Accept and join</Trans>
											)}
										</Button>
									</Group>
								</Stack>
							</Paper>
						);
					})}
				</Stack>
			</Stack>
		</Container>
	);
};
