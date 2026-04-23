import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Avatar,
	Badge,
	Box,
	Button,
	Container,
	Divider,
	Group,
	Loader,
	Modal,
	Paper,
	Radio,
	Select,
	Stack,
	Text,
	TextInput,
	Title,
	Tooltip,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { useDisclosure, useDocumentTitle } from "@mantine/hooks";
import { IconPlus, IconRefresh, IconTrash, IconX } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router";
import { toast } from "@/components/common/Toaster";
import { AccessRequestsList } from "@/components/workspace/AccessRequestsList";
import { TierBadge } from "@/components/workspace/TierBadge";
import { UsageCard } from "@/components/workspace/UsageCard";
import { API_BASE_URL, DIRECTUS_PUBLIC_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useV2Me } from "@/hooks/useV2Me";
import { useWorkspace } from "@/hooks/useWorkspace";

interface WorkspaceMember {
	id: string;
	user_id: string;
	display_name: string;
	email: string;
	avatar: string | null;
	role: string;
	source: string;
	is_external: boolean;
}

interface WorkspaceDetail {
	id: string;
	name: string;
	tier: string;
	org_id: string;
	org_name: string;
	is_default: boolean;
	members: WorkspaceMember[];
	pending_invites: Array<{
		id: string;
		email: string;
		role: string;
		created_at: string | null;
		invited_by_name: string | null;
		expires_at: string | null;
	}>;
	my_role: string;
	my_policies: string[];
	inherit_team_admins: boolean;
	inherit_team_members: boolean;
	description: string | null;
	logo_url: string | null;
}

async function fetchSettings(workspaceId: string): Promise<WorkspaceDetail | null> {
	const res = await fetch(`${API_BASE_URL}/v2/workspaces/${workspaceId}/settings`, {
		credentials: "include",
	});
	if (!res.ok) return null;
	return res.json();
}

async function sendInvite(workspaceId: string, email: string, role: string, isOrgMember: boolean) {
	const res = await fetch(`${API_BASE_URL}/v2/workspaces/${workspaceId}/invite`, {
		body: JSON.stringify({ email, is_org_member: isOrgMember, role }),
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		method: "POST",
	});
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(data.detail || "Failed to send invite");
	}
	return res.json();
}

async function removeMember(workspaceId: string, membershipId: string) {
	const res = await fetch(
		`${API_BASE_URL}/v2/workspaces/${workspaceId}/members/${membershipId}`,
		{ credentials: "include", method: "DELETE" },
	);
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(data.detail || "Failed to remove member");
	}
}

async function changeRole(workspaceId: string, membershipId: string, role: string) {
	const res = await fetch(
		`${API_BASE_URL}/v2/workspaces/${workspaceId}/members/${membershipId}`,
		{
			body: JSON.stringify({ role }),
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			method: "PATCH",
		},
	);
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(data.detail || "Failed to change role");
	}
}

async function updateWorkspace(
	workspaceId: string,
	payload: {
		name?: string;
		description?: string;
		logo_url?: string;
		inherit_team_admins?: boolean;
		inherit_team_members?: boolean;
	},
) {
	const res = await fetch(
		`${API_BASE_URL}/v2/workspaces/${workspaceId}/settings`,
		{
			body: JSON.stringify(payload),
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			method: "PATCH",
		},
	);
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(data.detail || "Failed to update workspace");
	}
}

async function resendInvite(workspaceId: string, inviteId: string): Promise<{ email_sent: boolean }> {
	const res = await fetch(
		`${API_BASE_URL}/v2/workspaces/${workspaceId}/invites/${inviteId}/resend`,
		{ credentials: "include", method: "POST" },
	);
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(data.detail || "Failed to resend invite");
	}
	return res.json();
}

async function cancelInvite(workspaceId: string, inviteId: string) {
	const res = await fetch(
		`${API_BASE_URL}/v2/workspaces/${workspaceId}/invites/${inviteId}`,
		{ credentials: "include", method: "DELETE" },
	);
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(data.detail || "Failed to cancel invite");
	}
}

export const WorkspaceSettingsRoute = () => {
	const { workspaceId } = useParams<{ workspaceId: string }>();
	const navigate = useI18nNavigate();
	const queryClient = useQueryClient();
	const { data: meV2 } = useV2Me();
	const { workspace: myWorkspaceSummary } = useWorkspace();
	// Guest = is_external on my direct row. Matrix §4: guest permissions
	// mirror member inside their assigned workspace, but they don't see
	// usage / privacy / pending invites (matrix §4 "View usage & overage"
	// row is ✗ for Guest).
	const iAmGuest = myWorkspaceSummary?.is_external === true;
	const [inviteEmail, setInviteEmail] = useState("");
	const [inviteRole, setInviteRole] = useState("member");
	const [editingName, setEditingName] = useState<string | null>(null);
	const [inviteModalOpened, { open: openInviteModal, close: closeInviteModal }] = useDisclosure(false);

	useDocumentTitle(t`Workspace settings | dembrane`);

	const { data: settings, isLoading } = useQuery({
		queryKey: ["v2", "workspace-settings", workspaceId],
		queryFn: () => (workspaceId ? fetchSettings(workspaceId) : null),
		enabled: !!workspaceId,
	});

	const inviteMutation = useMutation({
		mutationFn: () => {
			if (!workspaceId) throw new Error("No workspace");
			return sendInvite(workspaceId, inviteEmail.trim(), inviteRole, true);
		},
		onSuccess: (data) => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
			setInviteEmail("");
			setInviteRole("member");
			closeInviteModal();
			if (!data.email_sent) {
				toast.error(t`Invite created, but the email could not be sent. Share the link directly.`);
			} else if (data.status === "added") {
				toast.success(t`Member added`);
			} else {
				toast.success(t`Invite sent`);
			}
		},
		onError: (err: Error) => toast.error(err.message),
	});

	const resendInviteMutation = useMutation({
		mutationFn: (inviteId: string) => {
			if (!workspaceId) throw new Error("No workspace");
			return resendInvite(workspaceId, inviteId);
		},
		onSuccess: (data) => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
			if (data.email_sent) {
				toast.success(t`Invite resent`);
			} else {
				toast.error(t`Could not send the invite email. Check email configuration.`);
			}
		},
		onError: (err: Error) => toast.error(err.message),
	});

	const changeRoleMutation = useMutation({
		mutationFn: ({ membershipId, role }: { membershipId: string; role: string }) => {
			if (!workspaceId) throw new Error("No workspace");
			return changeRole(workspaceId, membershipId, role);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
			toast.success(t`Role updated`);
		},
		onError: (err: Error) => toast.error(err.message),
	});

	const renameMutation = useMutation({
		mutationFn: (name: string) => {
			if (!workspaceId) throw new Error("No workspace");
			return updateWorkspace(workspaceId, { name });
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces-context"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] });
			setEditingName(null);
			toast.success(t`Workspace renamed`);
		},
		onError: (err: Error) => toast.error(err.message),
	});

	const cancelInviteMutation = useMutation({
		mutationFn: (inviteId: string) => {
			if (!workspaceId) throw new Error("No workspace");
			return cancelInvite(workspaceId, inviteId);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
			toast.success(t`Invite canceled`);
		},
		onError: (err: Error) => toast.error(err.message),
	});

	const removeMutation = useMutation({
		mutationFn: (membershipId: string) => {
			if (!workspaceId) throw new Error("No workspace");
			return removeMember(workspaceId, membershipId);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
			toast.success(t`Member removed`);
		},
		onError: (err: Error) => toast.error(err.message),
	});

	// Self-leave. Same endpoint as removeMember but we surface different
	// success copy + route the user out.
	const leaveMutation = useMutation({
		mutationFn: (membershipId: string) => {
			if (!workspaceId) throw new Error("No workspace");
			return removeMember(workspaceId, membershipId);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
			toast.success(t`You left the workspace`);
			navigate("/w");
		},
		onError: (err: Error) => toast.error(err.message),
	});

	if (isLoading || !settings) {
		return (
			<Container size="sm" py="xl">
				<Stack align="center" mt="20vh">
					<Loader size="sm" color="gray" />
				</Stack>
			</Container>
		);
	}

	const canManage = settings.my_policies?.includes("member:manage") ?? false;
	const myRole = settings.my_role;
	const myAppUserId = meV2?.id ?? null;
	const canEditSettings = settings.my_policies?.includes("settings:manage") ?? false;

	return (
		<>
		<Container size="sm" py="xl" px="lg" pb={80}>
			<Stack gap={32}>
				{/* Header */}
				<Group justify="space-between" align="flex-start">
					<Stack gap={4} flex={1} maw={400}>
						{editingName !== null ? (
							<TextInput
								autoFocus
								size="md"
								value={editingName}
								onChange={(e) => setEditingName(e.currentTarget.value)}
								onBlur={() => {
									const trimmed = editingName.trim();
									if (trimmed && trimmed !== settings.name) {
										renameMutation.mutate(trimmed);
									} else {
										setEditingName(null);
									}
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter") e.currentTarget.blur();
									if (e.key === "Escape") setEditingName(null);
								}}
								disabled={renameMutation.isPending}
								styles={{ input: { fontSize: 20, fontWeight: 400 } }}
							/>
						) : (
							<Title
								order={3}
								fw={400}
								style={{ cursor: canEditSettings ? "pointer" : "default" }}
								onClick={() => canEditSettings && setEditingName(settings.name)}
							>
								{settings.name}
							</Title>
						)}
						<Group gap={8} wrap="nowrap">
							{iAmGuest ? (
								<Badge size="xs" variant="light" color="yellow">
									<Trans>Guest of {settings.org_name}</Trans>
								</Badge>
							) : (
								<TierBadge tier={settings.tier} size="xs" showTagline />
							)}
							{!iAmGuest && (
								<Text size="xs" c="dimmed">
									{settings.org_name}
								</Text>
							)}
						</Group>
					</Stack>
					<Button
						variant="subtle"
						size="xs"
						color="gray"
						onClick={() => navigate("/w")}
					>
						<Trans>Back to workspaces</Trans>
					</Button>
				</Group>

				<Divider />

				{/* Privacy + defaults — admin-only. Hidden entirely for non-
				    admin roles (HCD audit 2026-04-23): disabled fields read
				    as "broken" to members / billing / guests who can't edit
				    them. Show nothing rather than disabled state. */}
				{canEditSettings && (
					<>
						<PrivacyAndDefaultsSection
							settings={settings}
							canEdit={canEditSettings}
							workspaceId={workspaceId!}
						/>
						<Divider />
					</>
				)}

				{/* Usage + financial rollup (matrix §8). Role-aware rendering
				    lives inside the card — members see raw; admin/billing see
				    overage forecast + next-tier recommendation. Guests are
				    excluded entirely (matrix §4 "View usage & overage" ✗). */}
				{workspaceId && !iAmGuest && <UsageCard workspaceId={workspaceId} />}

				{!iAmGuest && <Divider />}

				{/* Members */}
				<Stack gap={16}>
					<Group justify="space-between">
						<Title order={5} fw={400}>
							<Trans>Members</Trans>
						</Title>
						<Text size="xs" c="dimmed">
							{settings.members.length} {settings.members.length === 1 ? t`member` : t`members`}
							{settings.pending_invites.length > 0 &&
								` · ${settings.pending_invites.length} ${t`pending`}`}
						</Text>
					</Group>

					{/* Invite button */}
					{canManage && (
						<Button
							size="sm"
							leftSection={<IconPlus size={14} />}
							variant="default"
							onClick={openInviteModal}
						>
							<Trans>Invite member</Trans>
						</Button>
					)}

					{/* Member list */}
					<Stack gap={0}>
						{settings.members.map((member, idx) => (
							<Paper
								key={member.id}
								p="sm"
								withBorder
								radius={0}
								style={{
									marginTop: idx > 0 ? -1 : 0,
								}}
							>
								<Group justify="space-between" wrap="nowrap">
									<Group gap={12} wrap="nowrap">
										<Avatar
											size={32}
											radius="xl"
											src={member.avatar ? `${DIRECTUS_PUBLIC_URL}/assets/${member.avatar}` : null}
											color="blue"
										>
											{member.display_name?.charAt(0)?.toUpperCase()}
										</Avatar>
										<Box>
											<Group gap={6}>
												<Text size="sm" lineClamp={1}>
													{member.display_name || member.email || t`Unknown member`}
												</Text>
												{member.is_external && (
													<Badge size="xs" variant="light" color="gray">
														<Trans>External</Trans>
													</Badge>
												)}
											</Group>
											{/* Two-line people pattern: name on top, email under it
											    in muted-xs. Email is empty when server redacted it
											    (non-manager reader); Stack ternary keeps the row
											    balanced. Source label tucks into the tail. */}
											{member.email && member.email !== member.display_name ? (
												<Text size="xs" c="dimmed" lineClamp={1}>
													{member.email}
													{member.source === "inherited" && (
														<>
															{" · "}
															<Text component="span" fs="italic">
																<Trans>inherited from team</Trans>
															</Text>
														</>
													)}
												</Text>
											) : (
												<Text size="xs" c="dimmed" style={{ textTransform: "capitalize" }}>
													{member.source === "inherited" ? t`inherited from team` : member.source}
												</Text>
											)}
										</Box>
									</Group>

									<Group gap={8}>
										{canManage ? (
											<Select
												// Owner option shown only to an actual owner —
												// backend blocks non-owner promotion to owner
												// anyway, but hiding the option prevents the
												// misleading "why did this fail?" click path.
												// Guests (is_external=true) can't be admin,
												// owner, or billing (hard rule).
												data={[
													{ label: t`Member`, value: "member" },
													...(!member.is_external
														? [
															{ label: t`Billing`, value: "billing" },
															{ label: t`Admin`, value: "admin" },
														]
														: []),
													...(myRole === "owner" && !member.is_external
														? [{ label: t`Owner`, value: "owner" }]
														: []),
												]}
												size="xs"
												value={member.role}
												w={100}
												onChange={(v) => {
													if (!v || v === member.role) return;
													// Footgun guard: demoting yourself out of
													// admin/owner is a one-way street without a
													// teammate's help. Confirm first.
													const isSelf = member.user_id === myAppUserId;
													const isDemotion =
														(member.role === "owner" ||
															member.role === "admin") &&
														v !== "owner" &&
														v !== "admin";
													if (isSelf && isDemotion) {
														modals.openConfirmModal({
															title: t`Change your own role?`,
															children: (
																<Stack gap="xs">
																	<Text size="sm">
																		<Trans>
																			You're about to change your own role to{" "}
																			<em>{v}</em>. You'll immediately lose
																			access to workspace settings, invites,
																			and member management.
																		</Trans>
																	</Text>
																	<Text size="sm" c="dimmed">
																		<Trans>
																			Another admin or owner will need to
																			restore you.
																		</Trans>
																	</Text>
																</Stack>
															),
															labels: {
																confirm: t`Change anyway`,
																cancel: t`Cancel`,
															},
															confirmProps: { color: "red" },
															onConfirm: () =>
																changeRoleMutation.mutate({
																	membershipId: member.id,
																	role: v,
																}),
														});
														return;
													}
													changeRoleMutation.mutate({
														membershipId: member.id,
														role: v,
													});
												}}
											/>
										) : (
											<Badge size="sm" variant="light" color="gray" style={{ textTransform: "capitalize" }}>
												{member.role}
											</Badge>
										)}
										{canManage && (
											<Tooltip label={t`Remove member`}>
												<ActionIcon
													color="red"
													size="sm"
													variant="subtle"
													loading={removeMutation.isPending}
													onClick={() => {
														modals.openConfirmModal({
															title: t`Remove member`,
															children: (
																<Text size="sm">
																	<Trans>
																		Remove {member.display_name} from this workspace?
																		They'll lose access to all projects inside it.
																	</Trans>
																</Text>
															),
															labels: { confirm: t`Remove`, cancel: t`Cancel` },
															confirmProps: { color: "red" },
															onConfirm: () => removeMutation.mutate(member.id),
														});
													}}
													aria-label={t`Remove member`}
												>
													<IconTrash size={14} />
												</ActionIcon>
											</Tooltip>
										)}
									</Group>
								</Group>
							</Paper>
						))}
					</Stack>
				</Stack>

				{/* Pending invites */}
				{settings.pending_invites.length > 0 && (
					<>
						<Divider />
						<Stack gap={12}>
							<Title order={5} fw={400}>
								<Trans>Pending invites</Trans>
							</Title>
							<Stack gap={0}>
								{settings.pending_invites.map((inv) => (
									<Paper key={inv.id} p="sm" withBorder radius={0}>
										<Group justify="space-between">
											<Box>
												<Text size="sm">{inv.email}</Text>
												<Text size="xs" c="dimmed">
													<span style={{ textTransform: "capitalize" }}>{inv.role}</span>
													{inv.invited_by_name && (
														<>
															{" · "}
															<Trans>invited by {inv.invited_by_name}</Trans>
														</>
													)}
												</Text>
											</Box>
											<Group gap={8}>
												<Badge size="xs" variant="light" color="yellow">
													<Trans>Pending</Trans>
												</Badge>
												<Tooltip label={t`Resend invite email`}>
													<ActionIcon
														color="blue"
														size="sm"
														variant="subtle"
														loading={resendInviteMutation.isPending}
														onClick={() => resendInviteMutation.mutate(inv.id)}
														aria-label={t`Resend invite`}
													>
														<IconRefresh size={14} />
													</ActionIcon>
												</Tooltip>
												<Tooltip label={t`Cancel invite`}>
													<ActionIcon
														color="gray"
														size="sm"
														variant="subtle"
														loading={cancelInviteMutation.isPending}
														onClick={() => {
															modals.openConfirmModal({
																title: t`Cancel invite`,
																children: (
																	<Text size="sm">
																		<Trans>
																			Cancel the invite sent to {inv.email}? You can invite them again later.
																		</Trans>
																	</Text>
																),
																labels: { confirm: t`Cancel invite`, cancel: t`Keep it` },
																confirmProps: { color: "red" },
																onConfirm: () => cancelInviteMutation.mutate(inv.id),
															});
														}}
														aria-label={t`Cancel invite`}
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
					</>
				)}

				{/* Matrix §6 access requests from team members. Hides itself
				    when nothing is pending. */}
				{canManage && workspaceId && (
					<AccessRequestsList workspaceId={workspaceId} />
				)}

				{/* Your access — role + self-leave. Raw policy strings removed
				    after HCD audit (2026-04-23). "Leave workspace" is new:
				    members + guests always had no self-exit path. Admins must
				    transfer first (backend enforces last-admin protection). */}
				<Divider />
				<Stack gap={12}>
					<Title order={5} fw={400}>
						<Trans>Your access</Trans>
					</Title>
					<Group justify="space-between" align="center">
						<Badge size="sm" variant="light" color="blue" style={{ textTransform: "capitalize" }}>
							{settings.my_role}
						</Badge>
						{(() => {
							const myMembership = settings.members.find(
								(m) => m.user_id === myAppUserId,
							);
							if (!myMembership) return null;
							// Offer Leave for any role; backend returns 400 if you're
							// the last admin/owner with a clear error we surface.
							return (
								<Button
									size="compact-xs"
									variant="subtle"
									color="gray"
									onClick={() => {
										modals.openConfirmModal({
											title: t`Leave workspace`,
											children: (
												<Text size="sm">
													<Trans>
														You'll lose access to this workspace. Projects
														you created stay; your role here is removed.
													</Trans>
												</Text>
											),
											labels: {
												confirm: t`Leave workspace`,
												cancel: t`Cancel`,
											},
											confirmProps: { color: "red" },
											onConfirm: () =>
												leaveMutation.mutate(myMembership.id),
										});
									}}
								>
									<Trans>Leave workspace</Trans>
								</Button>
							);
						})()}
					</Group>
				</Stack>
			</Stack>
		</Container>

			<Modal
				opened={inviteModalOpened}
				onClose={closeInviteModal}
				title={t`Invite a member`}
				centered
				size="md"
			>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						const trimmed = inviteEmail.trim();
						if (!trimmed) {
							toast.error(t`Enter an email address`);
							return;
						}
						if (!trimmed.includes("@")) {
							toast.error(t`Enter a valid email address`);
							return;
						}
						inviteMutation.mutate();
					}}
				>
					<Stack gap={16}>
						<TextInput
							autoFocus
							label={t`Email address`}
							placeholder={t`name@example.com`}
							size="sm"
							value={inviteEmail}
							onChange={(e) => setInviteEmail(e.currentTarget.value)}
						/>

						<Radio.Group
							label={t`Role`}
							value={inviteRole}
							onChange={setInviteRole}
						>
							<Stack gap={10} mt={8}>
								<Radio
									value="member"
									label={
										<Box>
											<Text size="sm">{t`Member`}</Text>
											<Text size="xs" c="dimmed">
												<Trans>Can create projects, run conversations, and generate reports.</Trans>
											</Text>
										</Box>
									}
								/>
								<Radio
									value="billing"
									label={
										<Box>
											<Text size="sm">{t`Billing`}</Text>
											<Text size="xs" c="dimmed">
												<Trans>Sees usage, invoices, and payment. Doesn't touch projects.</Trans>
											</Text>
										</Box>
									}
								/>
								<Radio
									value="admin"
									label={
										<Box>
											<Text size="sm">{t`Admin`}</Text>
											<Text size="xs" c="dimmed">
												<Trans>Everything a member can do, plus invite others and manage the workspace.</Trans>
											</Text>
										</Box>
									}
								/>
							</Stack>
						</Radio.Group>

						<Group justify="flex-end" gap={8} mt={8}>
							<Button variant="default" size="sm" onClick={closeInviteModal}>
								<Trans>Cancel</Trans>
							</Button>
							<Button
								size="sm"
								type="submit"
								loading={inviteMutation.isPending}
							>
								<Trans>Send invite</Trans>
							</Button>
						</Group>
					</Stack>
				</form>
			</Modal>
		</>
	);
};

/**
 * Privacy + defaults block on the workspace settings page.
 *
 * Three admin-editable things: logo URL (whitelabel — tier-gated
 * changemaker+), description, privacy toggle (`inherit_team_admins`).
 * Secondary `inherit_team_members` only appears when the workspace is
 * open — opens access to every team member, not just admins.
 */
function PrivacyAndDefaultsSection({
	settings,
	canEdit,
	workspaceId,
}: {
	settings: WorkspaceDetail;
	canEdit: boolean;
	workspaceId: string;
}) {
	const queryClient = useQueryClient();
	const [logo, setLogo] = useState<string | null>(null);
	const [description, setDescription] = useState<string | null>(null);
	const [inheritAdmins, setInheritAdmins] = useState<boolean | null>(null);
	const [inheritMembers, setInheritMembers] = useState<boolean | null>(null);

	const effectiveLogo = logo ?? settings.logo_url ?? "";
	const effectiveDesc = description ?? settings.description ?? "";
	const effectiveInheritAdmins = inheritAdmins ?? settings.inherit_team_admins;
	const effectiveInheritMembers = inheritMembers ?? settings.inherit_team_members;

	const dirty =
		(logo !== null && logo.trim() !== (settings.logo_url ?? "")) ||
		(description !== null && description !== (settings.description ?? "")) ||
		inheritAdmins !== null ||
		inheritMembers !== null;

	const saveMutation = useMutation({
		mutationFn: async () => {
			const payload: Record<string, unknown> = {};
			if (logo !== null && logo.trim() !== (settings.logo_url ?? "")) {
				payload.logo_url = logo.trim();
			}
			if (description !== null && description !== (settings.description ?? "")) {
				payload.description = description;
			}
			if (inheritAdmins !== null) payload.inherit_team_admins = inheritAdmins;
			if (inheritMembers !== null) payload.inherit_team_members = inheritMembers;
			await updateWorkspace(workspaceId, payload);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] });
			setLogo(null);
			setDescription(null);
			setInheritAdmins(null);
			setInheritMembers(null);
			toast.success(t`Saved`);
		},
		onError: (err: Error) => toast.error(err.message),
	});

	return (
		<Stack gap={16}>
			<Title order={5} fw={400}>
				<Trans>Privacy &amp; defaults</Trans>
			</Title>
			<TextInput
				label={t`Description`}
				description={t`Optional — what this workspace is for.`}
				value={effectiveDesc}
				onChange={(e) => setDescription(e.currentTarget.value)}
				disabled={!canEdit}
				maxLength={500}
			/>
			<TextInput
				label={t`Logo URL`}
				description={t`Custom workspace logo. Requires changemaker tier or above.`}
				placeholder="https://..."
				value={effectiveLogo}
				onChange={(e) => setLogo(e.currentTarget.value)}
				disabled={!canEdit}
				maxLength={2048}
			/>
			{(() => {
				// Matrix §2: Private workspaces are innovator+. If the current
				// tier can't go private, disable the radio + surface the
				// reason inline. Avoid the footgun of clicking Private on
				// Pioneer and getting a cryptic 403.
				const privateGateTiers = [
					"innovator",
					"changemaker",
					"guardian",
				];
				const canGoPrivate = privateGateTiers.includes(settings.tier);
				const currentlyPrivate = !effectiveInheritAdmins;
				return (
					<Radio.Group
						label={t`Access`}
						value={effectiveInheritAdmins ? "open" : "private"}
						onChange={(v) => setInheritAdmins(v === "open")}
					>
						<Stack gap={8} mt={4}>
							<Radio
								value="open"
								label={t`Open to the team — team admins get access automatically`}
								disabled={!canEdit}
							/>
							<Radio
								value="private"
								// Keep enabled if already private (matrix §3 freeze:
								// existing stays private even after downgrade) — just
								// block flipping-back-to-private on a lower tier.
								disabled={!canEdit || (!canGoPrivate && !currentlyPrivate)}
								label={
									<Stack gap={0}>
										<Text size="sm">
											<Trans>Private — only people you explicitly invite</Trans>
										</Text>
										{!canGoPrivate && !currentlyPrivate && (
											<Text size="xs" c="dimmed">
												<Trans>Available on innovator and above.</Trans>
											</Text>
										)}
									</Stack>
								}
							/>
						</Stack>
					</Radio.Group>
				);
			})()}
			{effectiveInheritAdmins && (
				<Group gap={8} align="flex-start" ml="md">
					<input
						type="checkbox"
						checked={effectiveInheritMembers}
						disabled={!canEdit}
						onChange={(e) => setInheritMembers(e.currentTarget.checked)}
						style={{ marginTop: 3 }}
						id="inherit-members"
					/>
					<Stack gap={0}>
						<Text component="label" htmlFor="inherit-members" size="sm">
							<Trans>Team members also get access</Trans>
						</Text>
						<Text size="xs" c="dimmed">
							<Trans>
								By default only admins inherit. Check this to open the workspace
								to everyone on the team.
							</Trans>
						</Text>
					</Stack>
				</Group>
			)}
			{canEdit && (
				<Group justify="flex-end">
					<Button
						variant="default"
						onClick={() => {
							setLogo(null);
							setDescription(null);
							setInheritAdmins(null);
							setInheritMembers(null);
						}}
						disabled={!dirty}
					>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						loading={saveMutation.isPending}
						disabled={!dirty}
						onClick={() => saveMutation.mutate()}
					>
						<Trans>Save</Trans>
					</Button>
				</Group>
			)}
		</Stack>
	);
}
