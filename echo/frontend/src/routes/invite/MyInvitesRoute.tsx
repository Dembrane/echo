import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
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
import { modals } from "@mantine/modals";
import { useDocumentTitle } from "@mantine/hooks";
import { toast } from "@/components/common/Toaster";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useAcceptInvite, useDeclineInvite, useMyInvites } from "@/hooks/useMyInvites";

export const MyInvitesRoute = () => {
	const navigate = useI18nNavigate();
	const { data: invites, isLoading } = useMyInvites();
	const acceptMutation = useAcceptInvite();
	const declineMutation = useDeclineInvite();

	useDocumentTitle(t`Pending invites | dembrane`);

	const handleAccept = async (inviteId: string, workspaceName: string) => {
		try {
			const data = await acceptMutation.mutateAsync(inviteId);
			toast.success(t`Joined ${workspaceName}`);
			navigate(`/w/${data.workspace_id}/projects`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to accept");
		}
	};

	const handleDecline = (inviteId: string, workspaceName: string) => {
		modals.openConfirmModal({
			title: t`Decline invite`,
			children: (
				<Text size="sm">
					<Trans>
						Decline the invite to {workspaceName}? You can ask them to send it again later.
					</Trans>
				</Text>
			),
			labels: { confirm: t`Decline`, cancel: t`Keep it` },
			confirmProps: { color: "red" },
			onConfirm: async () => {
				try {
					await declineMutation.mutateAsync(inviteId);
					toast.success(t`Invite declined`);
				} catch (err) {
					toast.error(err instanceof Error ? err.message : "Failed to decline");
				}
			},
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

	if (!invites || invites.length === 0) {
		return (
			<Container size="sm" py="xl" px="lg">
				<Stack gap={24} mt="10vh" align="center">
					<Title order={4} fw={400} c="dimmed">
						<Trans>No pending invites</Trans>
					</Title>
					<Button variant="default" size="sm" onClick={() => navigate("/w")}>
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
							Workspaces you've been invited to join. Accept to start collaborating.
						</Trans>
					</Text>
				</Stack>

				<Stack gap={12}>
					{invites.map((inv) => (
						<Paper key={inv.id} p="lg" radius="md" withBorder>
							<Stack gap={16}>
								<Group justify="space-between" align="flex-start" wrap="nowrap">
									<Box flex={1}>
										<Text fw={500} size="md">
											{inv.workspace_name}
										</Text>
										<Text size="xs" c="dimmed" mt={2}>
											{inv.org_name}
										</Text>
										<Group gap={6} mt={8}>
											<Badge size="xs" variant="light" color="gray" style={{ textTransform: "capitalize" }}>
												{inv.role}
											</Badge>
											{inv.invited_by_name && (
												<Text size="xs" c="dimmed">
													<Trans>invited by {inv.invited_by_name}</Trans>
												</Text>
											)}
										</Group>
									</Box>
								</Group>

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
										<Trans>Accept and join</Trans>
									</Button>
								</Group>
							</Stack>
						</Paper>
					))}
				</Stack>
			</Stack>
		</Container>
	);
};
