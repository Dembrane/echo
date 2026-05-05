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
import { useDisclosure, useDocumentTitle } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import { IconRefresh, IconTrash, IconUpload, IconX } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { toast } from "@/components/common/Toaster";
import { InviteMemberCard, MembersToolbar } from "@/components/members";
import { AccessRequestsList } from "@/components/workspace/AccessRequestsList";
import { TierBadge } from "@/components/workspace/TierBadge";
import { TierCapacityMatrix } from "@/components/workspace/TierCapacityMatrix";
import { UsageCard } from "@/components/workspace/UsageCard";
import { WorkspaceInviteWizard } from "@/components/workspace/WorkspaceInviteWizard";
import { API_BASE_URL, DIRECTUS_PUBLIC_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useUrlSearch } from "@/hooks/useUrlSearch";
import { useV2Me } from "@/hooks/useV2Me";
import { useWorkspace } from "@/hooks/useWorkspace";
import { logoUrl, memberInitials } from "@/lib/avatar";
import { displayRole } from "@/lib/roles";
import { seatOverageRateFor } from "@/lib/tiers";

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
	inherit_organisation_admins: boolean;
	inherit_organisation_members: boolean;
	description: string | null;
	logo_url: string | null;
}

async function deleteWorkspace(workspaceId: string) {
	const res = await fetch(`${API_BASE_URL}/v2/workspaces/${workspaceId}`, {
		credentials: "include",
		method: "DELETE",
	});
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(
			typeof data.detail === "string"
				? data.detail
				: "Couldn't delete workspace",
		);
	}
	return res.json().catch(() => ({}));
}

async function fetchSettings(
	workspaceId: string,
): Promise<WorkspaceDetail | null> {
	const res = await fetch(
		`${API_BASE_URL}/v2/workspaces/${workspaceId}/settings`,
		{
			credentials: "include",
		},
	);
	if (!res.ok) return null;
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

async function changeRole(
	workspaceId: string,
	membershipId: string,
	role: string,
) {
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
	const res = await fetch(`${API_BASE_URL}/v2/workspaces/${workspaceId}/logo`, {
		body,
		credentials: "include",
		method: "POST",
	});
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
	const res = await fetch(`${API_BASE_URL}/v2/workspaces/${workspaceId}/logo`, {
		credentials: "include",
		method: "DELETE",
	});
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
		inherit_organisation_admins?: boolean;
		inherit_organisation_members?: boolean;
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

async function resendInvite(
	workspaceId: string,
	inviteId: string,
): Promise<{ email_sent: boolean }> {
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
	// Externals don't have a manage surface at all (2026-04-24). Bounce
	// them back to the project list of the workspace they came in on.
	// Keep the effect above the loading gate so hook order is stable.
	useEffect(() => {
		if (iAmGuest && workspaceId) {
			navigate(`/w/${workspaceId}/projects`, { replace: true });
		}
	}, [iAmGuest, workspaceId, navigate]);
	const [deleteConfirm, setDeleteConfirm] = useState("");
	const [
		inviteModalOpened,
		{ open: openInviteModal, close: closeInviteModal },
	] = useDisclosure(false);
	const [memberSearch, setMemberSearch] = useUrlSearch();
	type WsRoleFilter = "all" | "admins" | "members" | "guests";
	const [memberRoleFilter, setMemberRoleFilter] = useState<WsRoleFilter>("all");

	// Tab state — path-driven (/w/:id/settings/<tab>). Declared BEFORE
	// the loading early-return below; moving any hook below the early
	// return changes hook count between renders and crashes React.
	const allowedTabs = ["general", "members", "billing", "danger"] as const;
	type TabValue = (typeof allowedTabs)[number];
	const segment = (splat ?? "").split("/")[0] || "";
	const segmentIsValid = (allowedTabs as readonly string[]).includes(segment);

	useDocumentTitle(t`Workspace settings | dembrane`);

	const { data: settings, isLoading } = useQuery({
		enabled: !!workspaceId,
		queryFn: () => (workspaceId ? fetchSettings(workspaceId) : null),
		queryKey: ["v2", "workspace-settings", workspaceId],
	});

	// Lightweight usage probe so the Members tab can disable the invite
	// card / show cap copy. Shares the cache key with UsageCard so we
	// don't double-fetch on the billing tab. monthOffset=0 only — caps
	// are a current-state thing, not a historical one.
	const { data: usageProbe } = useQuery({
		enabled: !!workspaceId,
		queryFn: async () => {
			if (!workspaceId) return null;
			const res = await fetch(
				`${API_BASE_URL}/v2/workspaces/${workspaceId}/usage`,
				{ credentials: "include" },
			);
			if (!res.ok) return null;
			return res.json() as Promise<{
				tier: string;
				member_invite_blocked?: boolean;
				guest_invite_blocked?: boolean;
				seat_count: number;
				seat_count_included: number | null;
				guest_count: number;
				guest_cap: number | null;
			}>;
		},
		queryKey: ["v2", "workspace-usage", workspaceId, 0],
		// Match the refetch policy of UsageCard / SeatCapBanner that
		// share this query key: switching tabs (Members ↔ Billing) or
		// re-focusing the window should reflect the live cap state, not
		// a 60-second-old snapshot.
		refetchOnMount: "always",
		refetchOnWindowFocus: "always",
		staleTime: 60_000,
	});

	// Prefer backend flags; fall back to client-side comparison so the UI
	// still works on deploys without the new flags. Hard-block tier list
	// must match server/dembrane/seat_capacity.py: tier_hard_blocks_seats.
	const tierIsHardBlock = usageProbe?.tier === "pilot";
	const memberCapHit =
		!!usageProbe &&
		usageProbe.seat_count_included != null &&
		usageProbe.seat_count >= usageProbe.seat_count_included;
	const guestCapHit =
		!!usageProbe &&
		usageProbe.guest_cap != null &&
		usageProbe.guest_count >= usageProbe.guest_cap;
	const memberInviteBlocked =
		usageProbe?.member_invite_blocked ?? (tierIsHardBlock && memberCapHit);
	const guestInviteBlocked = usageProbe?.guest_invite_blocked ?? guestCapHit;
	const inviteFullyBlocked = memberInviteBlocked && guestInviteBlocked;
	// Pioneer+ over included seats: not blocked, but the next member adds
	// to the workspace's monthly overage. Surface this in the InviteMember
	// helper text + wizard so admins see the cost before clicking Send,
	// not after the bill arrives.
	const memberOverageActive = !tierIsHardBlock && memberCapHit;
	const seatOverageRate = seatOverageRateFor(usageProbe?.tier);

	// The bulk-invite wizard handles its own POSTs + success toasts, so
	// there's no top-level inviteMutation anymore. Pending invites are
	// invalidated via the ["v2", "workspace-settings"] key it targets.

	const resendInviteMutation = useMutation({
		mutationFn: (inviteId: string) => {
			if (!workspaceId) throw new Error("No workspace");
			return resendInvite(workspaceId, inviteId);
		},
		onError: (err: Error) => toast.error(err.message),
		onSuccess: (data) => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
			if (data.email_sent) {
				toast.success(t`Invite resent`);
			} else {
				toast.error(
					t`Could not send the invite email. Check email configuration.`,
				);
			}
		},
	});

	const changeRoleMutation = useMutation({
		mutationFn: ({
			membershipId,
			role,
		}: {
			membershipId: string;
			role: string;
		}) => {
			if (!workspaceId) throw new Error("No workspace");
			return changeRole(workspaceId, membershipId, role);
		},
		onError: (err: Error) => toast.error(err.message),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
			toast.success(t`Role updated`);
		},
	});

	const cancelInviteMutation = useMutation({
		mutationFn: (inviteId: string) => {
			if (!workspaceId) throw new Error("No workspace");
			return cancelInvite(workspaceId, inviteId);
		},
		onError: (err: Error) => toast.error(err.message),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
			toast.success(t`Invite canceled`);
		},
	});

	const removeMutation = useMutation({
		mutationFn: (membershipId: string) => {
			if (!workspaceId) throw new Error("No workspace");
			return removeMember(workspaceId, membershipId);
		},
		onError: (err: Error) => toast.error(err.message),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
			toast.success(t`Member removed`);
		},
	});

	const deleteWorkspaceMutation = useMutation({
		mutationFn: () => {
			if (!workspaceId) throw new Error("No workspace");
			return deleteWorkspace(workspaceId);
		},
		onError: (err: Error) => toast.error(err.message),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "organisation"] });
			toast.success(t`Workspace deleted`);
			navigate("/w");
		},
	});

	// Self-leave. Same endpoint as removeMember but we surface different
	// success copy + route the user out.
	const leaveMutation = useMutation({
		mutationFn: (membershipId: string) => {
			if (!workspaceId) throw new Error("No workspace");
			return removeMember(workspaceId, membershipId);
		},
		onError: (err: Error) => toast.error(err.message),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
			toast.success(t`You left the workspace`);
			navigate("/w");
		},
	});

	// Tab resolution lives above the loading early-return to keep hook
	// order stable. Default depends on caller role, so until settings
	// loads we fall back to "general"; once loaded, the effect may fire
	// a second time with the role-correct default if the URL is bare.
	const callerCanManage =
		settings?.my_policies?.includes("member:manage") ?? false;
	const defaultTab: TabValue =
		settings?.my_role === "billing" && !callerCanManage ? "billing" : "general";
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

	// Members list order (2026-04-24): internals first — sorted by role
	// (owner → admin → billing → member) — then externals at the bottom.
	// Matches the mental model "who's in your organisation, then your guests."
	// Stable within each tier by display_name so the list doesn't shuffle
	// when roles change.
	const MEMBERS_ROLE_WEIGHT: Record<string, number> = {
		admin: 1,
		billing: 2,
		member: 3,
		owner: 0,
	};
	const sortedMembers = useMemo(() => {
		if (!settings) return [];
		return [...settings.members].sort((a, b) => {
			if (a.is_external !== b.is_external) return a.is_external ? 1 : -1;
			const ar = MEMBERS_ROLE_WEIGHT[a.role] ?? 99;
			const br = MEMBERS_ROLE_WEIGHT[b.role] ?? 99;
			if (ar !== br) return ar - br;
			return (a.display_name || a.email || "").localeCompare(
				b.display_name || b.email || "",
			);
		});
	}, [settings]);

	const filteredMembers = useMemo(() => {
		const q = memberSearch.trim().toLowerCase();
		return sortedMembers.filter((m) => {
			if (memberRoleFilter === "admins") {
				if (m.is_external) return false;
				if (!(m.role === "owner" || m.role === "admin")) return false;
			}
			if (memberRoleFilter === "members") {
				if (m.is_external) return false;
				if (m.role !== "member") return false;
			}
			if (memberRoleFilter === "guests" && !m.is_external) return false;
			if (!q) return true;
			return (
				(m.display_name || "").toLowerCase().includes(q) ||
				(m.email || "").toLowerCase().includes(q)
			);
		});
	}, [sortedMembers, memberSearch, memberRoleFilter]);

	const hasGuestMembers = useMemo(
		() => sortedMembers.some((m) => m.is_external),
		[sortedMembers],
	);

	if (isLoading || !settings) {
		return (
			<Container size="sm" py="xl">
				<Stack align="center" mt="20vh">
					<Loader size="sm" color="gray" />
				</Stack>
			</Container>
		);
	}

	// Guests don't have a settings surface (matrix §4). The useEffect above
	// kicks them to /projects, but that fires on the next tick — without
	// this early return the settings tabs flash briefly. Render nothing
	// while the redirect resolves.
	if (iAmGuest) {
		return null;
	}

	const canManage = callerCanManage;
	const myAppUserId = meV2?.id ?? null;
	const canEditSettings =
		settings.my_policies?.includes("settings:manage") ?? false;
	const seesFinancials =
		settings.my_policies?.includes("workspace:view_invoices") ?? false;

	return (
		<>
			{/* Container size matches OrganisationRoute (size="xl") so the two settings
		    pages feel like siblings — they used to diverge (workspace "sm"
		    = 720px; organisation "xl" = 1320px) which made workspace settings
		    feel cramped on desktop. */}
			<Container size="xl" py="xl" px="lg" pb={80}>
				<Stack gap={32}>
					{/* Header */}
					<Group justify="space-between" align="flex-start">
						<Stack gap={4} flex={1} maw={400}>
							{/* Header is display-only (2026-04-24). Renaming lives in
						    the General tab so all editable settings are in one
						    place. Keeping click-to-edit in the title was cute
						    but hid the permission: members saw the affordance
						    and got nothing on click. */}
							<Title order={3} fw={400}>
								{settings.name}
							</Title>
							{/* Header stays minimal — tier pill only, tagline lives on
						    the Billing tab where it's next to the price. Organisation name
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
						<Tabs value={activeTab} onChange={setActiveTab} keepMounted={false}>
							<Tabs.List>
								<Tabs.Tab value="general">
									<Trans>General</Trans>
								</Tabs.Tab>
								<Tabs.Tab value="members">
									<Trans>Members</Trans>
								</Tabs.Tab>
								<Tabs.Tab value="billing">
									<Trans>Usage and Tier</Trans>
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
													Every member with <em>Admin</em>, <em>Billing</em>, or{" "}
													<em>Member</em> role on this workspace counts as one
													seat. One person never takes more than one seat per
													workspace, even if they're on multiple organisations.
												</Trans>
											</Text>
											<Text size="xs" c="dimmed">
												<Trans>
													Guests don't take a seat. They can view and chat with
													projects you share with them, but can't create
													projects, invite others, see usage, or change
													workspace settings.
												</Trans>
											</Text>
											<Text size="xs" c="dimmed">
												<Trans>
													Going over your tier's included seats bills extra per
													month. See the matrix below for the per-seat rate on
													each tier.
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
												Invoices and payment method will land here in a future
												release. To upgrade, email{" "}
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
										<>
											<PrivacyAndDefaultsSection
												settings={settings}
												canEdit={canEditSettings}
												workspaceId={workspaceId!}
												section="general"
											/>
											<PrivacyAndDefaultsSection
												settings={settings}
												canEdit={canEditSettings}
												workspaceId={workspaceId!}
												section="access"
											/>
										</>
									)}
									{!canEditSettings && (
										<Text size="sm" c="dimmed">
											<Trans>
												Only workspace admins can change these settings. Ask an
												admin if something needs updating.
											</Trans>
										</Text>
									)}
								</Stack>
							</Tabs.Panel>

							<Tabs.Panel value="members" pt="md">
								<Stack gap={16}>
									<Group justify="space-between">
										<Title order={5} fw={400}>
											<Trans>Members</Trans>
										</Title>
										<Text size="xs" c="dimmed">
											{settings.members.length}{" "}
											{settings.members.length === 1 ? t`member` : t`members`}
											{settings.pending_invites.length > 0 &&
												` · ${settings.pending_invites.length} ${t`pending`}`}
										</Text>
									</Group>

									<MembersToolbar
										search={memberSearch}
										onSearchChange={setMemberSearch}
										filter={{
											onChange: (v) => setMemberRoleFilter(v as WsRoleFilter),
											options: [
												{ label: t`All`, value: "all" },
												{ label: t`Admins`, value: "admins" },
												{ label: t`Members`, value: "members" },
												...(hasGuestMembers
													? [{ label: t`Guests`, value: "guests" }]
													: []),
											],
											value: memberRoleFilter,
										}}
										count={{
											shown: filteredMembers.length,
											total: settings.members.length,
										}}
									/>

									<Stack gap="xs">
										{canManage && (
											<InviteMemberCard
												label={
													inviteFullyBlocked ? (
														<Trans>Workspace is full</Trans>
													) : (
														<Trans>Invite member</Trans>
													)
												}
												helperText={
													inviteFullyBlocked ? (
														<Trans>
															Both seat and guest limits reached for this tier.
															Free a seat or upgrade.
														</Trans>
													) : memberInviteBlocked ? (
														<Trans>
															Member seats full. You can still invite guests.
														</Trans>
													) : guestInviteBlocked ? (
														<Trans>
															Guest cap reached. You can still invite
															organisation members.
														</Trans>
													) : memberOverageActive && seatOverageRate != null ? (
														<Trans>
															You're over your included seats. Each new member
															adds €{seatOverageRate}/month to next bill.
														</Trans>
													) : memberOverageActive ? (
														<Trans>
															You're over your included seats. Overage applies
															on the next bill.
														</Trans>
													) : (
														<Trans>
															Add members or a guest to this workspace.
														</Trans>
													)
												}
												tooltip={
													inviteFullyBlocked ? (
														<Trans>
															Both seat and guest limits are full on this tier.
															Remove a member or guest, or upgrade the workspace
															tier to invite more people.
														</Trans>
													) : undefined
												}
												onClick={openInviteModal}
												disabled={inviteFullyBlocked}
											/>
										)}
										{settings.members.length === 0 && (
											<Stack align="center" gap={6} py={32}>
												<Text size="sm" fw={500}>
													<Trans>No one here yet.</Trans>
												</Text>
												<Text size="xs" c="dimmed" ta="center" maw={360}>
													<Trans>
														Invite members to collaborate on projects and
														conversations in this workspace.
													</Trans>
												</Text>
											</Stack>
										)}
										{filteredMembers.map((member) => (
											<Paper key={member.id} p="md" withBorder radius="md">
												<Group justify="space-between" wrap="nowrap">
													<Group gap={12} wrap="nowrap" style={{ minWidth: 0 }}>
														<Avatar
															size={32}
															radius="xl"
															src={
																member.avatar
																	? `${DIRECTUS_PUBLIC_URL}/assets/${member.avatar}`
																	: null
															}
															color="blue"
														>
															{memberInitials(
																member.display_name,
																member.email,
															)}
														</Avatar>
														<Box style={{ minWidth: 0 }}>
															<Group gap={6}>
																<Text size="sm" lineClamp={1} fw={500}>
																	{member.display_name ||
																		member.email ||
																		t`Unknown member`}
																	{member.user_id === myAppUserId && (
																		<Text component="span" c="dimmed" fw={400}>
																			{" "}
																			<Trans>(You)</Trans>
																		</Text>
																	)}
																</Text>
																{member.is_external && (
																	<Badge size="xs" variant="light" color="gray">
																		<Trans>Guest</Trans>
																	</Badge>
																)}
															</Group>
															{/* Two-line people pattern: name on top, email under it
											    in muted-xs. Email is empty when server redacted it
											    (non-manager reader); Stack ternary keeps the row
											    balanced. Source label tucks into the tail. */}
															{member.email &&
															member.email !== member.display_name ? (
																<Text size="xs" c="dimmed" lineClamp={1}>
																	{member.email}
																	{member.source === "inherited" && (
																		<>
																			{" · "}
																			<Text component="span" fs="italic">
																				<Trans>
																					inherited from organisation
																				</Trans>
																			</Text>
																		</>
																	)}
																</Text>
															) : (
																<Text
																	size="xs"
																	c="dimmed"
																	style={{ textTransform: "capitalize" }}
																>
																	{member.source === "inherited"
																		? t`inherited from organisation`
																		: member.source}
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
																	// member's help. Confirm first.
																	const isSelf = member.user_id === myAppUserId;
																	const isDemotion =
																		(member.role === "owner" ||
																			member.role === "admin") &&
																		v !== "owner" &&
																		v !== "admin";
																	if (isSelf && isDemotion) {
																		modals.openConfirmModal({
																			children: (
																				<Stack gap="xs">
																					<Text size="sm">
																						<Trans>
																							You're about to change your own
																							role to <em>{displayRole(v)}</em>.
																							You'll immediately lose access to
																							workspace settings, invites, and
																							member management.
																						</Trans>
																					</Text>
																					<Text size="sm" c="dimmed">
																						<Trans>
																							Another admin or owner will need
																							to restore you.
																						</Trans>
																					</Text>
																				</Stack>
																			),
																			confirmProps: { color: "red" },
																			labels: {
																				cancel: t`Cancel`,
																				confirm: t`Change anyway`,
																			},
																			onConfirm: () =>
																				changeRoleMutation.mutate({
																					membershipId: member.id,
																					role: v,
																				}),
																			title: t`Change your own role?`,
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
														{member.user_id === myAppUserId ? (
															// Self row uses the same trash icon as
															// other rows — the action is "leave" but
															// the visual language matches "remove" so
															// the column reads consistently. Backend
															// enforces last-admin protection; errors
															// bubble through the mutation toast.
															<Tooltip label={t`Leave workspace`}>
																<ActionIcon
																	color="red"
																	size="sm"
																	variant="subtle"
																	loading={leaveMutation.isPending}
																	onClick={() => {
																		modals.openConfirmModal({
																			children: (
																				<Text size="sm">
																					<Trans>
																						You'll lose access to this
																						workspace. Projects you created
																						stay; your role here is removed.
																					</Trans>
																				</Text>
																			),
																			confirmProps: { color: "red" },
																			labels: {
																				cancel: t`Cancel`,
																				confirm: t`Leave workspace`,
																			},
																			onConfirm: () =>
																				leaveMutation.mutate(member.id),
																			title: t`Leave workspace`,
																		});
																	}}
																	aria-label={t`Leave workspace`}
																>
																	<IconTrash size={14} />
																</ActionIcon>
															</Tooltip>
														) : (
															canManage && (
																<Tooltip label={t`Remove member`}>
																	<ActionIcon
																		color="red"
																		size="sm"
																		variant="subtle"
																		loading={removeMutation.isPending}
																		onClick={() => {
																			modals.openConfirmModal({
																				children: (
																					<Text size="sm">
																						<Trans>
																							Remove {member.display_name} from
																							this workspace? They'll lose
																							access to all projects inside it.
																						</Trans>
																					</Text>
																				),
																				confirmProps: { color: "red" },
																				labels: {
																					cancel: t`Cancel`,
																					confirm: t`Remove`,
																				},
																				onConfirm: () =>
																					removeMutation.mutate(member.id),
																				title: t`Remove member`,
																			});
																		}}
																		aria-label={t`Remove member`}
																	>
																		<IconTrash size={14} />
																	</ActionIcon>
																</Tooltip>
															)
														)}
													</Group>
												</Group>
											</Paper>
										))}
										{settings.members.length > 0 &&
											filteredMembers.length === 0 && (
												<Text size="sm" c="dimmed" ta="center" py="md">
													<Trans>No one matches that filter.</Trans>
												</Text>
											)}
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
											<Stack gap="xs">
												{settings.pending_invites.map((inv) => (
													<Paper key={inv.id} p="md" withBorder radius="md">
														<Group justify="space-between">
															<Box>
																<Text size="sm">{inv.email}</Text>
																<Text size="xs" c="dimmed">
																	<span>{displayRole(inv.role)}</span>
																	{inv.invited_by_name && (
																		<>
																			{" · "}
																			<Trans>
																				invited by {inv.invited_by_name}
																			</Trans>
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
																		onClick={() =>
																			resendInviteMutation.mutate(inv.id)
																		}
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
																				children: (
																					<Text size="sm">
																						<Trans>
																							Cancel the invite sent to{" "}
																							{inv.email}? You can invite them
																							again later.
																						</Trans>
																					</Text>
																				),
																				confirmProps: { color: "red" },
																				labels: {
																					cancel: t`Keep it`,
																					confirm: t`Cancel invite`,
																				},
																				onConfirm: () =>
																					cancelInviteMutation.mutate(inv.id),
																				title: t`Cancel invite`,
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

								{/* Matrix §6 access requests from organisation members. Hides itself
				    when nothing is pending. */}
								{canManage && workspaceId && (
									<AccessRequestsList workspaceId={workspaceId} />
								)}
							</Tabs.Panel>

							{canEditSettings && (
								<Tabs.Panel value="danger" pt="md">
									<Paper
										withBorder
										p="lg"
										radius="sm"
										style={{
											background: "rgba(234, 88, 88, 0.02)",
											borderColor: "rgba(234, 88, 88, 0.4)",
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
														immediately and all conversations and data are
														permanently removed.
													</Trans>
												</Text>
											</Stack>

											{(() => {
												const projectCount =
													settings.members.length > 0
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
															<Text size="sm">
																<Plural
																	value={liveProjectCount}
																	one="Delete the # project in this workspace before deleting the workspace itself."
																	other="Delete the # projects in this workspace before deleting the workspace itself."
																/>
															</Text>
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
																onClick={() => deleteWorkspaceMutation.mutate()}
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
													children: (
														<Text size="sm">
															<Trans>
																You'll lose access to this workspace.
															</Trans>
														</Text>
													),
													confirmProps: { color: "red" },
													labels: {
														cancel: t`Cancel`,
														confirm: t`Leave workspace`,
													},
													onConfirm: () =>
														leaveMutation.mutate(myMembership.id),
													title: t`Leave workspace`,
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

			{workspaceId && settings && (
				<WorkspaceInviteWizard
					opened={inviteModalOpened}
					onClose={closeInviteModal}
					workspaceId={workspaceId}
					orgId={settings.org_id}
					existingMemberAppUserIds={
						new Set(settings.members.map((m) => m.user_id))
					}
					memberInviteBlocked={memberInviteBlocked}
					guestInviteBlocked={guestInviteBlocked}
					memberOverageActive={memberOverageActive}
					seatOverageRate={seatOverageRate}
				/>
			)}
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
	const [name, setName] = useState<string>(settings.name ?? "");
	// Matrix §6 retired derivation — `inherit_organisation_admins` is now just
	// "Open vs Private." Legacy rows still read through this flag.
	const [isOpen, setIsOpen] = useState<boolean | null>(null);

	const effectiveIsOpen = isOpen ?? settings.inherit_organisation_admins;
	const privacyDirty = isOpen !== null;

	const descriptionMutation = useMutation({
		mutationFn: (value: string) =>
			updateWorkspace(workspaceId, { description: value }),
		onError: (err: Error) => {
			// Roll back local state on failure.
			setDescription(settings.description ?? "");
			toast.error(err.message);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] });
			toast.success(t`Saved`);
		},
	});

	// Name edit moved into the General tab (2026-04-24). Autosaves on
	// blur like description — the header still shows the name but is no
	// longer the edit surface. Read-only for members (canEdit=false).
	const nameMutation = useMutation({
		mutationFn: (value: string) =>
			updateWorkspace(workspaceId, { name: value }),
		onError: (err: Error) => {
			setName(settings.name ?? "");
			toast.error(err.message);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces-context"] });
			toast.success(t`Workspace renamed`);
		},
	});

	const privacyMutation = useMutation({
		mutationFn: async () => {
			if (isOpen === null) return;
			await updateWorkspace(workspaceId, {
				inherit_organisation_admins: isOpen,
			});
		},
		onError: (err: Error) => toast.error(err.message),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] });
			queryClient.invalidateQueries({
				queryKey: ["v2", "discoverable-workspaces", settings.org_id],
			});
			setIsOpen(null);
			toast.success(t`Saved`);
		},
	});

	// Logo upload lives on its own mutation so it commits immediately —
	// mirrors the user-settings whitelabel flow. Save button doesn't need
	// to wait on an image round-trip.
	const logoResetRef = useRef<() => void>(null);
	const uploadLogoMutation = useMutation({
		mutationFn: (file: File) =>
			uploadWorkspaceLogo(workspaceId, file, file.name || "logo.png"),
		onError: (err: Error) => toast.error(err.message),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] });
			toast.success(t`Logo updated`);
		},
	});
	const removeLogoMutation = useMutation({
		mutationFn: () => removeWorkspaceLogo(workspaceId),
		onError: (err: Error) => toast.error(err.message),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] });
			toast.success(t`Logo removed`);
		},
	});

	const currentLogoUrl = logoUrl(settings.logo_url);

	const handleLogoSelect = (file: File | null) => {
		logoResetRef.current?.();
		if (!file) return;
		uploadLogoMutation.mutate(file);
	};

	if (section === "general")
		return (
			<Stack gap={16}>
				<TextInput
					label={t`Name`}
					description={t`Workspace name. Autosaves on blur.`}
					placeholder={t`e.g. Client Alpha`}
					value={name}
					onChange={(e) => setName(e.currentTarget.value)}
					onBlur={() => {
						const trimmed = name.trim();
						if (!trimmed) {
							setName(settings.name ?? "");
							return;
						}
						if (trimmed !== (settings.name ?? "")) {
							nameMutation.mutate(trimmed);
						}
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
						if (e.key === "Escape") {
							setName(settings.name ?? "");
							(e.currentTarget as HTMLInputElement).blur();
						}
					}}
					disabled={!canEdit || nameMutation.isPending}
					maxLength={100}
				/>
				<TextInput
					label={t`Description`}
					description={t`Optional. What this workspace is for.`}
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
							<Trans>No logo set. dembrane default will be used.</Trans>
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
				const privateGateTiers = ["innovator", "changemaker", "guardian"];
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
											<Trans>Open to the organisation</Trans>
										</Text>
										<Text size="xs" c="dimmed">
											<Trans>
												Anyone in your organisation can find this workspace.
												Organisation admins can join; organisation members can
												request access.
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
												Only invited participants. Organisation admins can still
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
			{/* inherit_organisation_members toggle removed per matrix §6 — organisation members
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
