import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Badge,
	Box,
	Button,
	Container,
	Group,
	Paper,
	Skeleton,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { useState } from "react";
import { FetchErrorPanel } from "@/components/common/FetchErrorPanel";
import { toast } from "@/components/common/Toaster";
import { notifyError } from "@/components/error/notifyError";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import {
	useAcceptInvite,
	useDeclineInvite,
	useMyInvites,
} from "@/hooks/useMyInvites";
import { presentError } from "@/lib/errors/present";
import { openConfirm } from "@/lib/openConfirm";
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

	const handleAccept = async (inviteId: string, subjectName: string) => {
		setErrorByInvite((prev) => {
			const next = { ...prev };
			delete next[inviteId];
			return next;
		});
		try {
			const data = await acceptMutation.mutateAsync(inviteId);
			toast.success(t`Joined ${subjectName}`);
			// Org-only invites have no workspace target; land on /o where DiscoverableWorkspaces is mounted.
			if (data.type === "org" || !data.workspace_id) {
				navigate("/o");
			} else {
				navigate(`/w/${data.workspace_id}/home`);
			}
		} catch (err) {
			const msg = (await presentError(err, i18n)).message;
			setErrorByInvite((prev) => ({ ...prev, [inviteId]: msg }));
			toast.error(msg);
		}
	};

	const handleDecline = (inviteId: string, subjectName: string) => {
		openConfirm({
			children: (
				<Text size="sm">
					<Trans>
						Decline the invite to {subjectName}? You can ask them to send it
						again later.
					</Trans>
				</Text>
			),
			danger: true,
			labels: { cancel: t`Cancel`, confirm: t`Decline` },
			onConfirm: async () => {
				try {
					await declineMutation.mutateAsync(inviteId);
					toast.success(t`Invite declined`);
				} catch (err) {
					void notifyError(err);
				}
			},
			title: t`Decline invite`,
		});
	};

	if (isLoading) {
		return (
			<Container size="sm" py="xl" px="lg">
				<Stack gap="lg">
					<Skeleton height={32} width="40%" />
					<Skeleton height={120} />
					<Skeleton height={120} />
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
				<Stack gap="sm" align="flex-start">
					<Text size="sm" c="dimmed">
						<Trans>No pending invites</Trans>
					</Text>
					<Button size="sm" onClick={() => navigate("/o")}>
						<Trans>Back to workspaces</Trans>
					</Button>
				</Stack>
			</Container>
		);
	}

	return (
		<Container size="sm" py="xl" px="lg" pb={80}>
			<Stack gap="lg">
				<Stack gap="xs">
					<Title order={2}>
						<Trans>Pending invites</Trans>
					</Title>
					<Text size="sm" c="dimmed">
						{invites.some((inv) => inv.type === "org") ? (
							<Trans>Invitations waiting for you. Accept to get started.</Trans>
						) : (
							<Trans>
								Workspaces you've been invited to join. Accept to start
								collaborating.
							</Trans>
						)}
					</Text>
				</Stack>

				<Stack gap={0}>
					{invites.map((inv, index) => {
						const inviteError = errorByInvite[inv.id];
						const isOrgInvite = inv.type === "org";
						const subjectName = isOrgInvite
							? inv.org_name
							: (inv.workspace_name ?? inv.org_name);
						return (
							<Paper
								key={inv.id}
								p="lg"
								withBorder
								// One rule between rows, not two.
								style={index > 0 ? { borderTopWidth: 0 } : undefined}
							>
								<Stack gap="md">
									<Group
										justify="space-between"
										align="flex-start"
										wrap="nowrap"
									>
										<Box flex={1}>
											<Text size="md">{subjectName}</Text>
											{!isOrgInvite && (
												<Text size="xs" c="dimmed">
													{inv.org_name}
												</Text>
											)}
											<Group gap="xs" mt="sm">
												<Badge size="xs" variant="light" color="gray">
													{displayRole(inv.role)}
												</Badge>
												{isOrgInvite && (
													<Badge size="xs" variant="light" color="primary">
														<Trans>Organisation only</Trans>
													</Badge>
												)}
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
											<Stack gap="xs">
												<Text size="sm">
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

									<Group gap="sm">
										<Button
											variant="filled"
											flex={1}
											size="sm"
											loading={acceptMutation.isPending}
											onClick={() => handleAccept(inv.id, subjectName)}
										>
											{inviteError ? (
												<Trans>Try again</Trans>
											) : (
												<Trans>Accept and join</Trans>
											)}
										</Button>
										<Button
											size="sm"
											variant="subtle"
											color="gray"
											onClick={() => handleDecline(inv.id, subjectName)}
										>
											<Trans>Decline</Trans>
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
