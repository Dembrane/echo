import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Alert,
	Avatar,
	Badge,
	Box,
	Button,
	Container,
	Divider,
	FileButton,
	Group,
	Image,
	Loader,
	Modal,
	Paper,
	Radio,
	Select,
	Stack,
	Tabs,
	Text,
	TextInput,
	Title,
	Tooltip,
} from "@mantine/core";
import { modals } from "@mantine/modals";
import { useDisclosure, useDocumentTitle } from "@mantine/hooks";
import { IconPlus, IconRefresh, IconTrash, IconUpload, IconX } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { toast } from "@/components/common/Toaster";
import { AccessRequestsList } from "@/components/workspace/AccessRequestsList";
import { TierBadge } from "@/components/workspace/TierBadge";
import { TierCapacityMatrix } from "@/components/workspace/TierCapacityMatrix";
import { UsageCard } from "@/components/workspace/UsageCard";
import { API_BASE_URL, DIRECTUS_PUBLIC_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { logoUrl } from "@/lib/avatar";
import { displayRole } from "@/lib/roles";
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

async function deleteWorkspace(workspaceId: string) {
	const res = await fetch(`${API_BASE_URL}/v2/workspaces/${workspaceId}`, {
		method: "DELETE",
		credentials: "include",
	});
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(
			typeof data.detail === "string" ? data.detail : "Couldn't delete workspace",
		);
	}
	return res.json().catch(() => ({}));
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

async function uploadWorkspaceLogo(
	workspaceId: string,
	file: Blob,
	filename = "logo.png",
): Promise<string> {
	const body = new FormData();
	body.append("file", file, filename);
	const res = await fetch(
		`${API_BASE_URL}/v2/workspaces/${workspaceId}/logo`,
		{ method: "POST", credentials: "include", body },
	);
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(
			typeof data.detail === "string" ? data.detail : "Failed to upload logo",
		);
	}
	const data = await res.json();
	return data.file_id as string;
}

async function removeWorkspaceLogo(workspaceId: string): Promise<void> {
	const res = await fetch(
		`${API_BASE_URL}/v2/workspaces/${workspaceId}/logo`,
		{ method: "DELETE", credentials: "include" },
	);
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(
			typeof data.detail === "string" ? data.detail : "Failed to remove logo",
		);
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
	const { workspaceId, "*": splat } = useParams<{
		workspaceId: string;
		"*": string;
	}>();
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
	// Matrix §4: guests have workspace access only (is_external=true); no
	// team-level presence. Team members get a team row + workspace row.
	// UI toggle drives both the payload (is_org_member) and role clamp.
	const [inviteKind, setInviteKind] = useState<"team" | "guest">("team");
	const [deleteConfirm, setDeleteConfirm] = useState("");
	const [editingName, setEditingName] = useState<string | null>(null);
	const [inviteModalOpened, { open: openInviteModal, close: closeInviteModal }] = useDisclosure(false);

	// Tab state — path-driven (/w/:id/settings/<tab>). Declared BEFORE
	// the loading early-return below; moving any hook below the early
	// return changes hook count between renders and crashes React.
	const allowedTabs = [
		"general",
		"members",
		"access",
		"billing",
		"danger",
	] as const;
	type TabValue = (typeof allowedTabs)[number];
	const segment = (splat ?? "").split("/")[0] || "";
	const segmentIsValid = (allowedTabs as readonly string[]).includes(segment);

	useDocumentTitle(t`Workspace settings | dembrane`);

	const { data: settings, isLoading } = useQuery({
		queryKey: ["v2", "workspace-settings", workspaceId],
		queryFn: () => (workspaceId ? fetchSettings(workspaceId) : null),
		enabled: !!workspaceId,
	});

	const inviteMutation = useMutation({
		mutationFn: () => {
			if (!workspaceId) throw new Error("No workspace");
			// Guests are clamped to 'member' on the backend regardless of
			// what the UI sends (matrix §4 hard-rule). Reflect that here
			// so we never even send a wrong role.
			const effectiveRole = inviteKind === "guest" ? "member" : inviteRole;
			const isOrgMember = inviteKind === "team";
			return sendInvite(
				workspaceId,
				inviteEmail.trim(),
				effectiveRole,
				isOrgMember,
			);
		},
		onSuccess: (data) => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
			setInviteEmail("");
			setInviteRole("member");
			setInviteKind("team");
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

	const deleteWorkspaceMutation = useMutation({
		mutationFn: () => {
			if (!workspaceId) throw new Error("No workspace");
			return deleteWorkspace(workspaceId);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "team"] });
			toast.success(t`Workspace deleted`);
			navigate("/w");
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

	// Tab resolution lives above the loading early-return to keep hook
	// order stable. Default depends on caller role, so until settings
	// loads we fall back to "general"; once loaded, the effect may fire
	// a second time with the role-correct default if the URL is bare.
	const callerCanManage =
		settings?.my_policies?.includes("member:manage") ?? false;
	const defaultTab: TabValue =
		settings?.my_role === "billing" && !callerCanManage
			? "billing"
			: "general";
	const activeTab: TabValue = segmentIsValid
		? (segment as TabValue)
		: defaultTab;
	const setActiveTab = (value: string | null) => {
		if (!value || !workspaceId) return;
		navigate(`/w/${workspaceId}/settings/${value}`, { replace: true });
	};
	useEffect(() => {
		if (!workspaceId) return;
		if (segment !== activeTab) {
			navigate(`/w/${workspaceId}/settings/${activeTab}`, {
				replace: true,
			});
		}
	}, [workspaceId, segment, activeTab, navigate]);

	if (isLoading || !settings) {
		return (
			<Container size="sm" py="xl">
				<Stack align="center" mt="20vh">
					<Loader size="sm" color="gray" />
				</Stack>
			</Container>
		);
	}

	const canManage = callerCanManage;
	const myRole = settings.my_role;
	const myAppUserId = meV2?.id ?? null;
	const canEditSettings = settings.my_policies?.includes("settings:manage") ?? false;
	const seesFinancials =
		settings.my_policies?.includes("workspace:view_invoices") ?? false;

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
						{/* Header stays minimal — tier pill only, tagline lives on
						    the Billing tab where it's next to the price. Team name
						    is already in the nav breadcrumb; duplicating it here
						    was audit noise (2026-04-23). */}
						<Group gap={8} wrap="nowrap">
							{iAmGuest ? (
								<Badge size="xs" variant="light" color="yellow">
									<Trans>Guest of {settings.org_name}</Trans>
								</Badge>
							) : (
								<TierBadge tier={settings.tier} size="xs" />
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

				{/* Guests bypass the tab structure — they have one workspace
				    and nothing to navigate. Tabs come next for everyone else. */}
				{!iAmGuest && (
					<Tabs
						value={activeTab}
						onChange={setActiveTab}
						keepMounted={false}
					>
						<Tabs.List>
							<Tabs.Tab value="general">
								<Trans>General</Trans>
							</Tabs.Tab>
							<Tabs.Tab value="members">
								<Trans>Members</Trans>
							</Tabs.Tab>
							{canEditSettings && (
								<Tabs.Tab value="access">
									<Trans>Access</Trans>
								</Tabs.Tab>
							)}
							<Tabs.Tab value="billing">
								<Trans>Billing</Trans>
							</Tabs.Tab>
							{/* Matrix §4: delete-workspace is admin + owner. Tab
							    hidden for billing and member roles. */}
							{canEditSettings && (
								<Tabs.Tab value="danger" color="red">
									<Trans>Danger</Trans>
								</Tabs.Tab>
							)}
						</Tabs.List>

						<Tabs.Panel value="billing" pt="md">
							<Stack gap={16}>
								{workspaceId && <UsageCard workspaceId={workspaceId} />}

								{/* Seats explainer — audit feedback: users need to
								    know "how do seats work as a user" without
								    reading the matrix row. Short, matches §7. */}
								<Paper withBorder p="md" radius="sm">
									<Stack gap={8}>
										<Text size="sm" fw={500}>
											<Trans>How seats work</Trans>
										</Text>
										<Text size="xs" c="dimmed">
											<Trans>
												Every teammate with <em>Admin</em>,{" "}
												<em>Billing</em>, or <em>Member</em> role on
												this workspace counts as one seat. Guests
												(external participants) don't count toward
												seats. One person never takes more than one
												seat per workspace, even if they're on
												multiple teams.
											</Trans>
										</Text>
										<Text size="xs" c="dimmed">
											<Trans>
												Going over your tier's included seats bills
												extra per month — see the matrix below for
												the per-seat rate on each tier.
											</Trans>
										</Text>
									</Stack>
								</Paper>

								{/* Matrix §1 full capacity matrix on the billing tab.
								    Non-compact: price / duration / seats / overage /
								    hours / guests / training. Highlights the current
								    tier so admins can see what they have vs what's
								    next. */}
								<TierCapacityMatrix
									highlightTier={settings.tier}
									compact={false}
								/>
								{seesFinancials && (
									<Text size="xs" c="dimmed">
										<Trans>
											Invoices and payment method will land here in a
											future release. To upgrade, email{" "}
											<a
												href="mailto:upgrades@dembrane.com"
												style={{ color: "#4169e1" }}
											>
												upgrades@dembrane.com
											</a>
											.
										</Trans>
									</Text>
								)}
							</Stack>
						</Tabs.Panel>

						<Tabs.Panel value="general" pt="md">
							<Stack gap={24}>
								{canEditSettings && (
									<PrivacyAndDefaultsSection
										settings={settings}
										canEdit={canEditSettings}
										workspaceId={workspaceId!}
										section="general"
									/>
								)}
								{!canEditSettings && (
									<Text size="sm" c="dimmed">
										<Trans>
											Only workspace admins can change these settings.
											Ask an admin if something needs updating.
										</Trans>
									</Text>
								)}
							</Stack>
						</Tabs.Panel>

						{canEditSettings && (
							<Tabs.Panel value="access" pt="md">
								<PrivacyAndDefaultsSection
									settings={settings}
									canEdit={canEditSettings}
									workspaceId={workspaceId!}
									section="access"
								/>
							</Tabs.Panel>
						)}

						<Tabs.Panel value="members" pt="md">
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

					{/* Member list. Empty state hero if no members (rare —
					    creator is always a member — but guards against the
					    migration-time corner where the caller-row is the
					    only entry and got deduped upstream). */}
					{settings.members.length === 0 && (
						<Stack align="center" gap={6} py={32}>
							<Text size="sm" fw={500}>
								<Trans>No one here yet.</Trans>
							</Text>
							<Text size="xs" c="dimmed" ta="center" maw={360}>
								<Trans>
									Invite teammates to collaborate on projects and
									conversations in this workspace.
								</Trans>
							</Text>
						</Stack>
					)}
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
										{canManage && member.role === "owner" ? (
											// An owner row stays locked — the Select would
											// silently downgrade on any click because "owner"
											// isn't in its options. Ownership transfer is a
											// support flow, matrix §5.
											<Tooltip
												label={t`Ownership is locked. Contact support to transfer.`}
											>
												<Badge size="sm" variant="light" color="blue">
													<Trans>Admin</Trans>
												</Badge>
											</Tooltip>
										) : canManage ? (
											<Select
												// Matrix §5 retires "Owner" as a user-facing role
												// — only Admin + Member (+ Billing on non-guest
												// seats). A workspace with a DB-level "owner"
												// row still renders as Admin via displayRole();
												// ownership transfer is a separate support flow
												// and is not exposed in this picker. Guests
												// (is_external=true) can't hold Billing/Admin.
												data={[
													{ label: t`Member`, value: "member" },
													...(!member.is_external
														? [
															{ label: t`Billing`, value: "billing" },
															{ label: t`Admin`, value: "admin" },
														]
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
																			<em>{displayRole(v)}</em>. You'll immediately lose
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
											<Badge size="sm" variant="light" color="gray">
												{displayRole(member.role)}
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
													<span>{displayRole(inv.role)}</span>
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
						<Badge size="sm" variant="light" color="blue">
							{displayRole(settings.my_role)}
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
						</Tabs.Panel>

						{canEditSettings && (
							<Tabs.Panel value="danger" pt="md">
								<Paper
									withBorder
									p="lg"
									radius="sm"
									style={{
										borderColor: "rgba(234, 88, 88, 0.4)",
										background: "rgba(234, 88, 88, 0.02)",
									}}
								>
									<Stack gap={12}>
										<Stack gap={4}>
											<Title order={5} fw={400} c="red.9">
												<Trans>Delete this workspace</Trans>
											</Title>
											<Text size="sm" c="dimmed">
												<Trans>
													Delete this workspace. Members lose access
													immediately. Conversations and data stay
													recoverable for 30 days, then are permanently
													removed.
												</Trans>
											</Text>
										</Stack>

										{(() => {
											const projectCount = settings.members.length > 0
												? (myWorkspaceSummary?.project_count ?? 0)
												: 0;
											// Use the workspace summary for project count
											// (fresher than any in-settings field). If the
											// summary isn't loaded yet, we fall through to
											// showing the input — the endpoint itself will
											// 409 if projects sneak in between frames.
											const liveProjectCount =
												myWorkspaceSummary?.project_count ?? projectCount;

											if (liveProjectCount > 0) {
												return (
													<Alert color="yellow" variant="light">
														<Stack gap={6}>
															<Text size="sm">
																<Plural
																	value={liveProjectCount}
																	one="Clear the # project first. You can delete all projects across your team from the team page."
																	other="Clear the # projects first. You can delete all projects across your team from the team page."
																/>
															</Text>
															<Button
																size="compact-xs"
																variant="light"
																onClick={() =>
																	navigate(
																		`/t/${settings.org_id}/projects`,
																	)
																}
															>
																<Trans>Go to team projects</Trans>
															</Button>
														</Stack>
													</Alert>
												);
											}
											return (
												<Stack gap={8}>
													<Text size="xs" c="dimmed">
														<Trans>
															Type{" "}
															<Text
																span
																fs="italic"
																style={{ color: "#4169e1" }}
															>
																{settings.name}
															</Text>{" "}
															to confirm.
														</Trans>
													</Text>
													<TextInput
														placeholder={settings.name}
														value={deleteConfirm}
														onChange={(e) =>
															setDeleteConfirm(e.currentTarget.value)
														}
														size="sm"
													/>
													<Group justify="flex-end">
														<Button
															size="sm"
															color="red"
															disabled={deleteConfirm !== settings.name}
															loading={deleteWorkspaceMutation.isPending}
															onClick={() =>
																deleteWorkspaceMutation.mutate()
															}
														>
															<Trans>Delete workspace</Trans>
														</Button>
													</Group>
												</Stack>
											);
										})()}
									</Stack>
								</Paper>
							</Tabs.Panel>
						)}
					</Tabs>
				)}

				{/* Guest view — minimal, no tabs. They can see their own
				    access block + leave affordance, nothing else. */}
				{iAmGuest && (
					<Stack gap={12}>
						<Title order={5} fw={400}>
							<Trans>Your access</Trans>
						</Title>
						<Group justify="space-between" align="center">
							<Badge size="sm" variant="light" color="yellow">
								<Trans>Guest</Trans>
							</Badge>
							{(() => {
								const myMembership = settings.members.find(
									(m) => m.user_id === myAppUserId,
								);
								if (!myMembership) return null;
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
															You'll lose access to this workspace.
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
				)}
			</Stack>
		</Container>

			<Modal
				opened={inviteModalOpened}
				onClose={closeInviteModal}
				title={
					inviteKind === "guest" ? t`Invite a guest` : t`Invite a member`
				}
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

						{/* Member vs External framing (demo feedback): using the
						    user's mental model. Member joins your team + counts
						    as a team seat. External has workspace-only access,
						    no team presence, clamped to member-equivalent
						    permissions (matrix §4 hard-rule). */}
						<Radio.Group
							label={t`This person is`}
							value={inviteKind}
							onChange={(v) => setInviteKind(v as "team" | "guest")}
						>
							<Stack gap={10} mt={8}>
								<Radio
									value="team"
									label={
										<Box>
											<Text size="sm"><Trans>Member</Trans></Text>
											<Text size="xs" c="dimmed">
												<Trans>
													On your team. Gets a team seat (counts toward
													your plan) + access to this workspace.
												</Trans>
											</Text>
										</Box>
									}
								/>
								<Radio
									value="guest"
									label={
										<Box>
											<Text size="sm"><Trans>External</Trans></Text>
											<Text size="xs" c="dimmed">
												<Trans>
													Not on your team. Workspace-only access,
													doesn't count as a seat.
												</Trans>
											</Text>
										</Box>
									}
								/>
							</Stack>
						</Radio.Group>

						{/* Role radio — only for team-member invites. Guests are
						    member-equivalent by hard rule (matrix §4); no choice. */}
						{inviteKind === "team" && (
							<Radio.Group
								label={t`Workspace role`}
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
						)}

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
 * Workspace settings form — split across two tabs per 2026-04-23 audit.
 *
 * `section="general"` renders description + logo.
 * `section="access"` renders the Open/Private radio + its upgrade gate.
 *
 * State lives in this component and is shared between the two instances
 * so both tabs hit the same mutations and query cache.
 */
function PrivacyAndDefaultsSection({
	settings,
	canEdit,
	workspaceId,
	section = "general",
}: {
	settings: WorkspaceDetail;
	canEdit: boolean;
	workspaceId: string;
	section?: "general" | "access";
}) {
	const queryClient = useQueryClient();
	// Description autosaves on blur (non-critical text). Privacy keeps
	// explicit Save — flipping Open↔Private changes who can see the
	// workspace's data and is the one thing in this form where "oops"
	// is expensive.
	const [description, setDescription] = useState<string>(
		settings.description ?? "",
	);
	// Matrix §6 retired derivation — `inherit_team_admins` is now just
	// "Open vs Private." Legacy rows still read through this flag.
	const [isOpen, setIsOpen] = useState<boolean | null>(null);

	const effectiveIsOpen = isOpen ?? settings.inherit_team_admins;
	const privacyDirty = isOpen !== null;

	const descriptionMutation = useMutation({
		mutationFn: (value: string) =>
			updateWorkspace(workspaceId, { description: value }),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] });
			toast.success(t`Saved`);
		},
		onError: (err: Error) => {
			// Roll back local state on failure.
			setDescription(settings.description ?? "");
			toast.error(err.message);
		},
	});

	const privacyMutation = useMutation({
		mutationFn: async () => {
			if (isOpen === null) return;
			await updateWorkspace(workspaceId, { inherit_team_admins: isOpen });
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] });
			setIsOpen(null);
			toast.success(t`Saved`);
		},
		onError: (err: Error) => toast.error(err.message),
	});

	// Logo upload lives on its own mutation so it commits immediately —
	// mirrors the user-settings whitelabel flow. Save button doesn't need
	// to wait on an image round-trip.
	const logoResetRef = useRef<() => void>(null);
	const uploadLogoMutation = useMutation({
		mutationFn: (file: File) =>
			uploadWorkspaceLogo(workspaceId, file, file.name || "logo.png"),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] });
			toast.success(t`Logo updated`);
		},
		onError: (err: Error) => toast.error(err.message),
	});
	const removeLogoMutation = useMutation({
		mutationFn: () => removeWorkspaceLogo(workspaceId),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] });
			toast.success(t`Logo removed`);
		},
		onError: (err: Error) => toast.error(err.message),
	});

	const currentLogoUrl = logoUrl(settings.logo_url);

	const handleLogoSelect = (file: File | null) => {
		logoResetRef.current?.();
		if (!file) return;
		uploadLogoMutation.mutate(file);
	};

	if (section === "general") return (
		<Stack gap={16}>
			<TextInput
				label={t`Description`}
				description={t`Optional — what this workspace is for.`}
				placeholder={t`e.g. Client onboarding interviews, Q1 product research`}
				value={description}
				onChange={(e) => setDescription(e.currentTarget.value)}
				onBlur={() => {
					const next = description;
					if (next !== (settings.description ?? "")) {
						descriptionMutation.mutate(next);
					}
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
					if (e.key === "Escape") {
						setDescription(settings.description ?? "");
						(e.currentTarget as HTMLInputElement).blur();
					}
				}}
				disabled={!canEdit || descriptionMutation.isPending}
				maxLength={500}
			/>
			<Stack gap={6}>
				<Text size="sm" fw={500}>
					<Trans>Logo</Trans>
				</Text>
				<Text size="xs" c="dimmed">
					<Trans>
						Custom workspace logo. Requires changemaker tier or above.
					</Trans>
				</Text>
				{currentLogoUrl ? (
					<Group gap="sm" align="center">
						<Image
							src={currentLogoUrl}
							alt={t`Workspace logo`}
							h={48}
							w="auto"
							fit="contain"
							style={{ maxWidth: 200 }}
						/>
						<Button
							variant="subtle"
							color="red"
							size="compact-sm"
							leftSection={<IconTrash size={14} />}
							loading={removeLogoMutation.isPending}
							disabled={!canEdit}
							onClick={() => removeLogoMutation.mutate()}
						>
							<Trans>Remove</Trans>
						</Button>
					</Group>
				) : (
					<Text size="xs" c="dimmed" fs="italic">
						<Trans>No logo set — dembrane default will be used.</Trans>
					</Text>
				)}
				{/* No single-click "Replace" — destructive step is explicit.
				    Remove, then the slot re-opens to upload again. */}
				{!currentLogoUrl && (
					<FileButton
						resetRef={logoResetRef}
						onChange={handleLogoSelect}
						accept="image/png,image/jpeg,image/webp"
						disabled={!canEdit}
					>
						{(props) => (
							<Button
								variant="light"
								size="compact-sm"
								leftSection={<IconUpload size={14} />}
								loading={uploadLogoMutation.isPending}
								style={{ alignSelf: "flex-start" }}
								{...props}
							>
								<Trans>Upload logo</Trans>
							</Button>
						)}
					</FileButton>
				)}
			</Stack>
		</Stack>
	);

	// section === "access"
	return (
		<Stack gap={16}>
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
				const currentlyPrivate = !effectiveIsOpen;
				return (
					<Radio.Group
						label={t`Access`}
						value={effectiveIsOpen ? "open" : "private"}
						onChange={(v) => setIsOpen(v === "open")}
					>
						<Stack gap={8} mt={4}>
							<Radio
								value="open"
								label={
									<Stack gap={0}>
										<Text size="sm">
											<Trans>Open to the team</Trans>
										</Text>
										<Text size="xs" c="dimmed">
											<Trans>
												Anyone in your team can find this workspace. Team
												admins can join; team members can request access.
											</Trans>
										</Text>
									</Stack>
								}
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
											<Trans>Private</Trans>
										</Text>
										<Text size="xs" c="dimmed">
											<Trans>
												Only invited participants. Team admins can still
												find and join.
											</Trans>
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
			{/* inherit_team_members toggle removed per matrix §6 — team members
			    now go through the explicit Request-access flow; no automatic
			    derivation. Backend still accepts the flag for legacy rows
			    but we don't expose it. */}
			{canEdit && privacyDirty && (
				<Group justify="flex-end">
					<Button
						variant="default"
						onClick={() => setIsOpen(null)}
						disabled={privacyMutation.isPending}
					>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						loading={privacyMutation.isPending}
						onClick={() => privacyMutation.mutate()}
					>
						<Trans>Confirm privacy change</Trans>
					</Button>
				</Group>
			)}
		</Stack>
	);
}
