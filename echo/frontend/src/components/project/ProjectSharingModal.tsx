import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Alert,
	Avatar,
	Badge,
	Button,
	Group,
	Modal,
	Stack,
	Text,
} from "@mantine/core";
import { usePostHog } from "@posthog/react";
import { useQueryClient } from "@tanstack/react-query";
import { IconAlertTriangle, IconTrash, IconX } from "@tabler/icons-react";
import { useState } from "react";
import { toast } from "@/components/common/Toaster";
import {
	type EmailChip,
	EmailChipsInput,
} from "@/components/invite/EmailChipsInput";
import { ApiError } from "@/components/invite/api";
import { type InviteRole, RoleSelect } from "@/components/invite/RoleSelect";
import { useRevokeInvite } from "@/components/members/hooks";
import {
	type InviteBatchResult,
	invalidateProjectSharing,
	summarizeInviteResults,
	projectInvitesKey,
	shareWithEmails,
	useAddProjectShare,
	useInviteToWorkspaceWithProject,
	useProjectPendingInvites,
	useProjectShares,
	useRevokeProjectShare,
	useSetProjectVisibility,
} from "@/hooks/useProjectSharing";
import { useV2Me } from "@/hooks/useV2Me";
import { useWorkspace } from "@/hooks/useWorkspace";
import { avatarUrl, memberInitials } from "@/lib/avatar";
import { displayRole, isAdminRole } from "@/lib/roles";

interface ProjectSharingModalProps {
	projectId: string;
	opened: boolean;
	visibility: "workspace" | "private";
	workspaceName?: string;
	onClose: () => void;
}

/**
 * "Who can see this project?" modal (designer Ask 3 / W3.2).
 *
 * Emails are collected as chips (same input as the workspace invite modal)
 * and shared in one go. A share only unlocks the private project: what each
 * person can do there is their workspace role, so shares carry no level of
 * their own. Emails that aren't on the workspace yet are listed in a warning,
 * a RoleSelect appears, and the primary button becomes Send invite: a
 * workspace invite that carries the project share (server grants it on
 * accept). Still no cross-workspace sharing.
 *
 * When visibility='workspace', the modal offers the Make Private action
 * with an innovator+ hint if the server rejects. When visibility='private',
 * it shows the share list + add affordance.
 */
export function ProjectSharingModal({
	projectId,
	opened,
	visibility,
	workspaceName,
	onClose,
}: ProjectSharingModalProps) {
	const { data: shares, isLoading } = useProjectShares(projectId);
	// Batched: one invalidation pass after the loop (see handleShare).
	const addShare = useAddProjectShare(projectId, false);
	const revoke = useRevokeProjectShare(projectId);
	const setVisibility = useSetProjectVisibility(projectId);
	const { workspaceId, workspace } = useWorkspace();
	const { data: me } = useV2Me();
	const inviteAndShare = useInviteToWorkspaceWithProject(
		workspaceId,
		projectId,
		workspace?.org_id,
	);
	// Mirrors the server's member:invite policy (admin/owner). The server still
	// enforces it; this only decides whether to offer Send invite or the hint.
	const canInvite = isAdminRole(workspace?.role);
	const { data: pendingInvitesList } = useProjectPendingInvites(
		projectId,
		visibility === "private" && canInvite,
	);
	const queryClient = useQueryClient();
	const posthog = usePostHog();
	const revokeInvite = useRevokeInvite({
		orgId: workspace?.org_id,
		workspaceId: workspaceId ?? undefined,
	});
	const handleRevokeInvite = async (inviteId: string) => {
		try {
			await revokeInvite.mutateAsync(inviteId);
			queryClient.invalidateQueries({ queryKey: projectInvitesKey(projectId) });
			toast.success(t`Invite revoked`);
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : t`Couldn't revoke invite`,
			);
		}
	};
	// RoleSelect filters options by the inviter's level; non-admins never reach it.
	const inviterLevel: "member" | "admin" | "owner" =
		workspace?.role === "owner" || workspace?.role === "admin"
			? workspace.role
			: "member";

	// Billing can't open projects; observer only exists in external-client workspaces.
	const inviteRoleExclusions: InviteRole[] = workspace?.bills_separately
		? ["billing"]
		: ["billing", "observer"];

	const [chips, setChips] = useState<EmailChip[]>([]);
	// Workspace role for people who still need an invite.
	const [inviteRole, setInviteRole] = useState<InviteRole>("member");
	// True once the server said the remaining chips aren't on the workspace yet.
	const [needsInvite, setNeedsInvite] = useState(false);
	const [sharing, setSharing] = useState(false);

	const validChips = chips.filter((c) => c.state === "valid");
	const hasInvalidChips = chips.some((c) => c.state !== "valid");
	const validEmails = validChips.map((c) => c.value.trim().toLowerCase());
	const inviteStep = needsInvite && validEmails.length > 0;
	const pendingInvites = inviteStep ? validEmails : [];

	const resetAddForm = () => {
		setChips([]);
		setInviteRole("member");
		setNeedsInvite(false);
	};

	const handleChipsChange = (next: EmailChip[]) => {
		setChips(next);
		// Editing the list invalidates the "needs invite" answer.
		setNeedsInvite(false);
	};

	const handleShare = async () => {
		if (validEmails.length === 0) return;
		setSharing(true);
		try {
			const result = await shareWithEmails(validEmails, (vars) =>
				addShare.mutateAsync(vars),
			);
			if (result.shared.length > 0) {
				invalidateProjectSharing(queryClient, projectId, workspaceId);
			}
			for (const f of result.failed) {
				toast.error(`${f.email}: ${f.message}`);
			}
			// Same local name as the invite path so both sites share one message id.
			const granted = result.shared.length;
			if (granted === 1) {
				toast.success(t`Added`);
			} else if (granted > 1) {
				toast.success(t`Added ${granted} people`);
			}
			if (result.needsInvite.length > 0) {
				// Keep only the emails that still need an invite. Functional form:
				// the user may have removed a chip while the batch was running.
				setChips((prev) =>
					prev.filter((c) =>
						result.needsInvite.includes(c.value.trim().toLowerCase()),
					),
				);
				setNeedsInvite(true);
			} else if (result.failed.length === 0) {
				handleClose();
			} else {
				setChips((prev) =>
					prev.filter((c) =>
						result.failed.some((f) => f.email === c.value.trim().toLowerCase()),
					),
				);
			}
		} finally {
			setSharing(false);
		}
	};

	const handleSendInvites = async () => {
		if (pendingInvites.length === 0) return;
		let results: InviteBatchResult;
		try {
			results = await inviteAndShare.mutateAsync({
				emails: pendingInvites,
				role: inviteRole,
			});
		} catch (err) {
			toast.error(err instanceof Error ? err.message : t`Couldn't send invite`);
			return;
		}
		const summary = summarizeInviteResults(results);
		// Destructured on purpose: Lingui keys a message on the placeholder
		// expression, so `summary.sent` would emit a positional {0} id and miss
		// the translated {sent} entry in every catalog.
		const { granted, sent, alreadyPending } = summary;
		posthog?.capture("invite_sent", {
			count: pendingInvites.length,
			role: inviteRole,
			workspace_count: 1,
			source: "project_sharing",
		});
		for (const { email, reason } of summary.failed) {
			if (reason instanceof ApiError && reason.status === 403) {
				toast.error(t`Ask a workspace admin to invite this collaborator.`);
			} else {
				toast.error(
					`${email}: ${reason instanceof Error ? reason.message : t`Couldn't send invite`}`,
				);
			}
		}
		for (const email of summary.otherProject) {
			toast.error(
				t`${email} already has a pending invite for another project. Share this project once they join.`,
			);
		}
		for (const email of summary.emailNotSent) {
			toast.error(
				t`${email} was added to the pending list but the invite email could not be sent. Resend it from Members.`,
			);
		}
		if (granted > 0) {
			toast.success(granted === 1 ? t`Added` : t`Added ${granted} people`);
		}
		if (alreadyPending > 0) {
			toast.success(
				alreadyPending === 1
					? t`Already invited. The project is shared once they join.`
					: t`${alreadyPending} people were already invited. The project is shared once they join.`,
			);
		}
		if (sent === 1) {
			toast.success(t`Invite sent. The project is shared once they join.`);
		} else if (sent > 1) {
			toast.success(
				t`${sent} invites sent. The project is shared once they join.`,
			);
		}
		// Anything the admin still has to act on keeps the modal open.
		if (summary.allClean) handleClose();
	};

	const handleMakePrivate = async () => {
		try {
			await setVisibility.mutateAsync("private");
			// Designer's Q3 recommendation: confirm the state + point at
			// the next action without preaching.
			toast.success(t`Private. Add people to share it.`);
		} catch (err) {
			const msg =
				err instanceof Error ? err.message : t`Couldn't change visibility`;
			toast.error(msg);
		}
	};

	const handleMakeOpen = async () => {
		try {
			await setVisibility.mutateAsync("workspace");
			toast.success(
				workspaceName
					? t`Project is now visible to everyone in ${workspaceName}`
					: t`Project is now visible to the workspace`,
			);
			handleClose();
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : t`Couldn't change visibility`,
			);
		}
	};

	const handleClose = () => {
		resetAddForm();
		onClose();
	};

	const title = (
		<Text size="lg" fw={500}>
			<Trans>Who can see this project?</Trans>
		</Text>
	);

	if (visibility === "workspace") {
		return (
			<Modal opened={opened} onClose={onClose} title={title} centered size="md">
				<Stack gap="md">
					<Alert color="gray" variant="light">
						<Text size="sm">
							{workspaceName ? (
								<Trans>
									This project is visible to everyone in {workspaceName}.
								</Trans>
							) : (
								<Trans>
									This project is visible to everyone in the workspace.
								</Trans>
							)}
						</Text>
						<Text size="xs" c="dimmed" mt={4}>
							<Trans>
								Make it private to share with specific people only. Private
								projects require the innovator plan or above.
							</Trans>
						</Text>
					</Alert>
					<Group justify="flex-end">
						<Button variant="subtle" onClick={onClose}>
							<Trans>Cancel</Trans>
						</Button>
						<Button
							loading={setVisibility.isPending}
							onClick={handleMakePrivate}
						>
							<Trans>Make private</Trans>
						</Button>
					</Group>
				</Stack>
			</Modal>
		);
	}

	return (
		<Modal
			opened={opened}
			onClose={handleClose}
			title={title}
			centered
			size="lg"
		>
			<Stack gap="md">
				<Text size="sm">
					<Trans>
						Add people by email. Anyone not in the workspace yet gets an invite
						and access to this project when they join.
					</Trans>
				</Text>

				{/* Current shares */}
				<Stack gap="xs">
					{isLoading && <Text size="sm">…</Text>}
					{!isLoading &&
						(shares?.length ?? 0) === 0 &&
						(pendingInvitesList?.length ?? 0) === 0 && (
							<Text size="sm" c="dimmed">
								<Trans>Just you, for now.</Trans>
							</Text>
						)}
					{shares?.map((share) => (
						<Group key={share.user_id} gap="sm" wrap="nowrap">
							<Avatar size="sm" radius="xl" src={avatarUrl(share.avatar, 48)}>
								{memberInitials(share.display_name, share.email)}
							</Avatar>
							<Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
								<Text size="sm" truncate>
									{share.display_name || share.email || t`Unknown`}
								</Text>
								{/* Email always shown next to the name when we got one
								    back — the server already redacts for non-managers
								    of private projects. */}
								{share.email && share.email !== share.display_name && (
									<Text size="xs" c="dimmed" truncate>
										{share.email}
									</Text>
								)}
							</Stack>
							{share.workspace_role && (
								<Badge size="xs" variant="light" color="gray">
									{displayRole(share.workspace_role)}
								</Badge>
							)}
							<ActionIcon
								variant="subtle"
								color="gray"
								size="sm"
								onClick={() => {
									revoke
										.mutateAsync(share.user_id)
										.catch((err: Error) => toast.error(err.message));
								}}
							>
								<IconTrash size={14} />
							</ActionIcon>
						</Group>
					))}
					{pendingInvitesList?.map((inv) => (
						<Group
							key={inv.id}
							gap="sm"
							wrap="nowrap"
							data-testid="project-share-pending-row"
						>
							<Avatar size="sm" radius="xl">
								{memberInitials("", inv.email)}
							</Avatar>
							<Text size="sm" truncate style={{ flex: 1, minWidth: 0 }}>
								{inv.email}
							</Text>
							<Badge size="xs" variant="outline" color="gray">
								<Trans>Pending</Trans>
							</Badge>
							<Badge size="xs" variant="light" color="gray">
								{displayRole(inv.role)}
							</Badge>
							<ActionIcon
								variant="subtle"
								color="gray"
								size="sm"
								aria-label={t`Revoke invite`}
								loading={revokeInvite.isPending}
								onClick={() => void handleRevokeInvite(inv.id)}
							>
								<IconX size={14} />
							</ActionIcon>
						</Group>
					))}
				</Stack>

				{/* Add form: chips, submitted from the footer */}
				<EmailChipsInput
					chips={chips}
					onChipsChange={handleChipsChange}
					selfEmail={me?.email ?? null}
					disabled={sharing || inviteAndShare.isPending}
					data-testid="project-share-emails"
				/>

				{/* Not on the workspace yet: warn, and swap the footer to Cancel / Send invite */}
				{inviteStep && (
					<Alert
						color="yellow"
						variant="light"
						p="xs"
						icon={<IconAlertTriangle size={16} />}
						data-testid="project-share-invite-prompt"
					>
						<Text size="sm" style={{ overflowWrap: "anywhere" }}>
							{pendingInvites.length === 1 ? (
								canInvite ? (
									<Trans>
										{pendingInvites[0]} isn't in this workspace yet.
									</Trans>
								) : (
									<Trans>
										{pendingInvites[0]} isn't in this workspace yet. Ask a
										workspace admin to invite this collaborator.
									</Trans>
								)
							) : canInvite ? (
								<Trans>
									{pendingInvites.length} people aren't in this workspace yet.
								</Trans>
							) : (
								<Trans>
									{pendingInvites.length} people aren't in this workspace yet.
									Ask a workspace admin to invite them.
								</Trans>
							)}
						</Text>
					</Alert>
				)}

				{/* Workspace role for the people being invited; same picker as the invite modal */}
				{inviteStep && canInvite && (
					<RoleSelect
						value={inviteRole}
						onChange={setInviteRole}
						inviterLevel={inviterLevel}
						exclude={inviteRoleExclusions}
						data-testid="project-share-invite-role"
					/>
				)}

				<Group justify="space-between" mt="md">
					<Button
						variant="outline"
						size="sm"
						onClick={handleMakeOpen}
						loading={setVisibility.isPending}
					>
						<Trans>Share with whole workspace</Trans>
					</Button>
					<Group gap="xs">
						<Button
							variant="subtle"
							size="sm"
							onClick={handleClose}
							data-testid="project-share-cancel"
						>
							<Trans>Cancel</Trans>
						</Button>
						{inviteStep ? (
							<Button
								size="sm"
								loading={inviteAndShare.isPending}
								disabled={!canInvite}
								onClick={handleSendInvites}
								data-testid="project-share-invite-confirm"
							>
								{pendingInvites.length > 1 ? (
									<Trans>Send {pendingInvites.length} invites</Trans>
								) : (
									<Trans>Send invite</Trans>
								)}
							</Button>
						) : (
							<Button
								size="sm"
								loading={sharing}
								disabled={validChips.length === 0 || hasInvalidChips}
								onClick={handleShare}
								data-testid="project-share-confirm"
							>
								{validChips.length > 1 ? (
									<Trans>Share with {validChips.length} people</Trans>
								) : (
									<Trans>Share</Trans>
								)}
							</Button>
						)}
					</Group>
				</Group>
			</Stack>
		</Modal>
	);
}
