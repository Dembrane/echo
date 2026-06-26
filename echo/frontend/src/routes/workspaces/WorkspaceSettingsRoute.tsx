import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Alert,
	Anchor,
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
	Switch,
	Tabs,
	Text,
	TextInput,
	Title,
	Tooltip,
} from "@mantine/core";
import { useDisclosure, useDocumentTitle } from "@mantine/hooks";
import { modals } from "@mantine/modals";
import { IconLock, IconTrash, IconUpload } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "react-router";
import {
	BillingManager,
	OrgManagedBillingNotice,
} from "@/components/billing/BillingManager";
import { AccessDeniedPanel } from "@/components/common/AccessDeniedPanel";
import { ConfirmModal } from "@/components/common/ConfirmModal";
import { FetchErrorPanel } from "@/components/common/FetchErrorPanel";
import { ImageCropModal } from "@/components/common/ImageCropModal";
import { toast } from "@/components/common/Toaster";
import { InviteModal } from "@/components/invite/InviteModal";
import {
	InviteMemberCard,
	MembersToolbar,
	PendingInvitesSection,
} from "@/components/members";
import { usePendingInvites } from "@/components/members/hooks";
import { WorkspaceTrainingPanel } from "@/components/training";
import { AccessRequestsList } from "@/components/workspace/AccessRequestsList";
import { UpgradeModal } from "@/components/workspace/FeatureGate";
import { TierBadge } from "@/components/workspace/TierBadge";
import { UsageCard } from "@/components/workspace/UsageCard";
import { WorkspaceDataOwnershipSection } from "@/components/workspace/WorkspaceDataOwnershipSection";
import { API_BASE_URL, DIRECTUS_PUBLIC_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useUrlSearch } from "@/hooks/useUrlSearch";
import { useV2Me } from "@/hooks/useV2Me";
import { useWorkspace } from "@/hooks/useWorkspace";
import { WorkspaceAccessDeniedError } from "@/lib/accessDenied";
import { logoUrl, memberInitials } from "@/lib/avatar";
import { displayRole, isOutsiderRole } from "@/lib/roles";
import type { BillingPeriod, Tier } from "@/lib/tiers";

interface WorkspaceMember {
	id: string;
	user_id: string;
	display_name: string;
	email: string;
	avatar: string | null;
	role: string;
	source: string;
}

// Helper: external collaborators are identified by role==='external'
// (ADR-0003). Drives badge + filter logic across this route.
const isExternalMember = (m: { role: string }): boolean =>
	m.role === "external";

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
	visibility: "open_to_organisation" | "invite_only" | "private";
	inherit_organisation_members: boolean;
	allow_support_access: boolean;
	description: string | null;
	logo_url: string | null;
	type_discount: string | null;
	percent_discount: number | null;
	billing_period: BillingPeriod | null;
	billing_account_id: string | null;
	billing_status: string | null;
	billing_org_managed: boolean;
	usage_context: string | null;
	is_external_client: boolean;
	data_owner_org_name: string | null;
	data_owner_email: string | null;
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
	if (res.status === 401 || res.status === 403 || res.status === 404) {
		throw new WorkspaceAccessDeniedError(res.status);
	}
	// Throw rather than null — null falls into the loader branch and spins forever.
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(
			typeof data.detail === "string"
				? data.detail
				: t`Couldn't load workspace settings (${res.status})`,
		);
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
		visibility?: "open_to_organisation" | "invite_only" | "private";
		inherit_organisation_members?: boolean;
		allow_support_access?: boolean;
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

export const WorkspaceSettingsRoute = () => {
	const { workspaceId, "*": splat } = useParams<{
		workspaceId: string;
		"*": string;
	}>();
	const navigate = useI18nNavigate();
	const { search: urlSearch } = useLocation();
	const queryClient = useQueryClient();
	const { data: meV2 } = useV2Me();
	const { workspace: myWorkspaceSummary } = useWorkspace();
	// Outsiders (external + observer) have no manage surface; bounce them home.
	const iAmOutsider = isOutsiderRole(myWorkspaceSummary?.role);
	// Keep the effect above the loading gate so hook order is stable.
	useEffect(() => {
		if (iAmOutsider && workspaceId) {
			navigate(`/w/${workspaceId}/home`, { replace: true });
		}
	}, [iAmOutsider, workspaceId, navigate]);
	const [deleteConfirm, setDeleteConfirm] = useState("");
	const [
		inviteModalOpened,
		{ open: openInviteModal, close: closeInviteModal },
	] = useDisclosure(false);
	const [memberSearch, setMemberSearch] = useUrlSearch();

	type WsRoleFilter = "all" | "admins" | "billing" | "members" | "externals";
	const [memberRoleFilter, setMemberRoleFilter] = useState<WsRoleFilter>("all");

	// Tab state — path-driven (/w/:id/settings/<tab> or /w/:id/members). Declared BEFORE
	// the loading early-return below; moving any hook below the early
	// return changes hook count between renders and crashes React.
	const allowedTabs = [
		"general",
		"members",
		"training",
		"billing",
		"danger",
	] as const;
	type TabValue = (typeof allowedTabs)[number];
	const { pathname } = useLocation();
	const segment = pathname.includes("/members")
		? "members"
		: (splat ?? "").split("/")[0] || "";
	const segmentIsValid = (allowedTabs as readonly string[]).includes(segment);

	useDocumentTitle(t`Workspace settings | dembrane`);

	const {
		data: settings,
		isLoading,
		error: settingsError,
	} = useQuery({
		enabled: !!workspaceId,
		queryFn: () => (workspaceId ? fetchSettings(workspaceId) : null),
		queryKey: ["v2", "workspace-settings", workspaceId],
		// Other admins' member changes show up within 30s. Idle tabs skip.
		refetchInterval: 30_000,
		refetchIntervalInBackground: false,
		// 403/404 is stable, not flaky — skip retries so the panel surfaces
		// instantly instead of waiting ~30s for retries to exhaust.
		retry: (failureCount, err) =>
			err instanceof WorkspaceAccessDeniedError ? false : failureCount < 3,
	});

	// Live count for the "N pending" counter; endpoint is org-admin-only so gate via enabled.
	const { data: livePendingInvites } = usePendingInvites({
		enabled:
			!!workspaceId &&
			!!settings?.org_id &&
			(settings?.my_policies?.includes("member:manage") ?? false),
		orgId: settings?.org_id,
		workspaceId,
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
				seat_invite_blocked?: boolean;
				seat_count: number;
				seat_count_included: number | null;
				member_count: number;
				external_count: number;
				pending_count: number;
			}>;
		},
		queryKey: ["v2", "workspace-usage", workspaceId, 0],
		refetchOnMount: "always",
		refetchOnWindowFocus: "always",
		staleTime: 60_000,
	});

	const seatCapHit =
		!!usageProbe &&
		usageProbe.seat_count_included != null &&
		usageProbe.seat_count >= usageProbe.seat_count_included;
	const seatInviteBlocked = usageProbe?.seat_invite_blocked ?? seatCapHit;
	// Only Free hard-caps seats now; paid tiers are per-seat metered (never block).
	const tierHardBlocks = usageProbe?.tier === "free";

	// The bulk-invite wizard handles its own POSTs + success toasts, so
	// there's no top-level inviteMutation anymore. Pending invites are
	// invalidated via the ["v2", "workspace-settings"] key it targets.

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
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-usage"] });
			toast.success(t`Role updated`);
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
			// Frees a seat — re-enable invite button.
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-usage"] });
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
			navigate("/o");
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
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-usage"] });
			toast.success(t`You left the workspace`);
			navigate("/o");
		},
	});

	// Tab resolution lives above the loading early-return to keep hook
	// order stable. Default depends on caller role, so until settings
	// loads we fall back to "general"; once loaded, the effect may fire
	// a second time with the role-correct default if the URL is bare.
	const callerCanManage = useMemo(() => {
		if (!settings) return false;
		return settings.my_policies?.includes("member:manage") ?? false;
	}, [settings]);

	const canEditSettings = useMemo(() => {
		if (!settings) return false;
		return settings.my_policies?.includes("settings:manage") ?? false;
	}, [settings]);

	const defaultTab = useMemo<TabValue | null>(() => {
		if (!settings) return null;
		return canEditSettings
			? "general"
			: settings.my_role === "billing"
				? "billing"
				: "members";
	}, [settings, canEditSettings]);

	const activeTab: TabValue = useMemo(() => {
		if (segmentIsValid) {
			return segment as TabValue;
		}
		return defaultTab ?? "general";
	}, [segmentIsValid, segment, defaultTab]);

	const setActiveTab = (value: string | null) => {
		if (!value || !workspaceId) return;
		navigate(`/w/${workspaceId}/settings/${value}${urlSearch}`, {
			replace: true,
		});
	};

	useEffect(() => {
		if (!workspaceId || !settings || !defaultTab) return;
		if (pathname.includes("/settings/members")) {
			navigate(`/w/${workspaceId}/members${urlSearch}`, {
				replace: true,
			});
			return;
		}
		if (segment !== activeTab) {
			const destPath =
				activeTab === "members" ? "members" : `settings/${activeTab}`;
			navigate(`/w/${workspaceId}/${destPath}${urlSearch}`, {
				replace: true,
			});
		}
	}, [
		workspaceId,
		segment,
		activeTab,
		navigate,
		urlSearch,
		settings,
		defaultTab,
		pathname,
	]);

	// Members list order (2026-04-24): internals first — sorted by role
	// (owner → admin → billing → member) — then externals at the bottom.
	// Matches the mental model "who's in your organisation, then your externals."
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
			if (isExternalMember(a) !== isExternalMember(b))
				return isExternalMember(a) ? 1 : -1;
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
				if (isExternalMember(m)) return false;
				if (!(m.role === "owner" || m.role === "admin")) return false;
			}
			if (memberRoleFilter === "members") {
				if (isExternalMember(m)) return false;
				if (m.role !== "member") return false;
			}
			if (memberRoleFilter === "billing") {
				if (isExternalMember(m)) return false;
				if (m.role !== "billing") return false;
			}
			if (memberRoleFilter === "externals" && !isExternalMember(m))
				return false;
			if (!q) return true;
			return (
				(m.display_name || "").toLowerCase().includes(q) ||
				(m.email || "").toLowerCase().includes(q)
			);
		});
	}, [sortedMembers, memberSearch, memberRoleFilter]);

	const hasExternalMembers = useMemo(
		() => sortedMembers.some((m) => isExternalMember(m)),
		[sortedMembers],
	);

	// Show Billing chip only when ≥1 billing-role member exists (mirrors hasExternalMembers).
	const hasBillingMembers = useMemo(
		() =>
			sortedMembers.some((m) => !isExternalMember(m) && m.role === "billing"),
		[sortedMembers],
	);

	// Used to lock the role picker for the only admin so they can't trap themselves.
	const adminLikeCount = useMemo(
		() =>
			sortedMembers.filter(
				(m) =>
					!isExternalMember(m) && (m.role === "admin" || m.role === "owner"),
			).length,
		[sortedMembers],
	);

	// Must come before the loading branch — otherwise a 403 reads as "loading forever."
	if (settingsError instanceof WorkspaceAccessDeniedError) {
		return <AccessDeniedPanel testId="workspace-settings-access-denied" />;
	}

	if (isLoading) {
		return (
			<Container size="sm" py="xl">
				<Stack align="center" mt="20vh">
					<Loader size="sm" color="gray" />
				</Stack>
			</Container>
		);
	}

	// Without this, !settings falls into the loader branch and spins forever.
	if (settingsError || !settings) {
		return (
			<FetchErrorPanel
				onRetry={() =>
					queryClient.invalidateQueries({
						queryKey: ["v2", "workspace-settings", workspaceId],
					})
				}
				detail={settingsError instanceof Error ? settingsError.message : null}
				message={
					<Trans>We couldn't load this workspace. Try again in a moment.</Trans>
				}
			/>
		);
	}
	if (!workspaceId) return null;

	// Externals don't have a settings surface (matrix §4). The useEffect above
	// kicks them to workspace home, but that fires on the next tick — without
	// this early return the settings tabs flash briefly. Render nothing
	// while the redirect resolves.
	if (iAmOutsider) {
		return null;
	}

	const canManage = callerCanManage;
	const myAppUserId = meV2?.id ?? null;
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
							<Group gap={8} wrap="wrap">
								{iAmOutsider ? (
									<Badge size="xs" variant="light" color="yellow">
										<Trans>External of {settings.org_name}</Trans>
									</Badge>
								) : (
									<TierBadge
										tier={settings.tier}
										size="xs"
										billsSeparately={
											!settings.billing_org_managed && !!settings.org_id
										}
									/>
								)}
								{!iAmOutsider && settings.type_discount && (
									<Badge size="xs" variant="light" color="teal" tt="capitalize">
										{settings.type_discount.replace(/_/g, " ")}
									</Badge>
								)}
								{!iAmOutsider &&
									settings.percent_discount != null &&
									settings.percent_discount > 0 && (
										<Badge size="xs" variant="light" color="teal">
											{settings.percent_discount}% discount
										</Badge>
									)}
							</Group>
						</Stack>
						<Button
							variant="subtle"
							size="xs"
							color="gray"
							onClick={() => navigate("/o")}
						>
							<Trans>Back to workspaces</Trans>
						</Button>
					</Group>

					<Divider />

					{/* Externals bypass the tab structure — they have one workspace
				    and nothing to navigate. Tabs come next for everyone else. */}
					{!iAmOutsider && (
						<Tabs value={activeTab} onChange={setActiveTab} keepMounted={false}>
							{/* Tab strip hidden — the main AppSidebar drives section
							    navigation. Internal Tabs.value still wires the panels via URL. */}

							<Tabs.Panel value="billing" pt="md">
								<Stack gap={16}>
									{workspaceId && <UsageCard workspaceId={workspaceId} />}
									{seesFinancials && settings.billing_org_managed && (
										<OrgManagedBillingNotice
											orgId={settings.org_id}
											orgName={settings.org_name}
										/>
									)}
									{/* ISSUE-017: members (no view_invoices) still see usage
									    counts above, plus a one-line pointer to org settings
									    where billing lives when org-managed. Admins get the
									    full OrgManagedBillingNotice instead. */}
									{!seesFinancials && settings.billing_org_managed && (
										<Text size="sm">
											<Trans>
												Usage is tracked for your organisation. View it in
												organisation settings.
											</Trans>
										</Text>
									)}

									{seesFinancials &&
										!settings.billing_org_managed &&
										settings.org_id && (
											<Paper withBorder p="md" radius="sm">
												<Text size="sm">
													<Trans>This workspace is billed separately</Trans>
												</Text>
												<Text size="xs" c="dimmed" mt={4}>
													<Trans>
														It has its own plan and seats, not{" "}
														{settings.org_name}'s pooled plan. Changes here only
														affect this workspace.
													</Trans>
												</Text>
											</Paper>
										)}

									{seesFinancials &&
										workspaceId &&
										!settings.billing_org_managed && (
											<BillingManager
												accountId={settings.billing_account_id}
												invalidateKeys={[
													["v2", "workspace-settings", workspaceId],
												]}
												source="workspace_billing"
											/>
										)}
								</Stack>
							</Tabs.Panel>

							<Tabs.Panel value="training" pt="md">
								{settings.org_id && (
									<WorkspaceTrainingPanel orgId={settings.org_id} />
								)}
							</Tabs.Panel>

							<Tabs.Panel value="general" pt="md">
								<Stack gap={24}>
									{canEditSettings && (
										<>
											<PrivacyAndDefaultsSection
												settings={settings}
												canEdit={canEditSettings}
												workspaceId={workspaceId}
												section="general"
											/>
											<PrivacyAndDefaultsSection
												settings={settings}
												canEdit={canEditSettings}
												workspaceId={workspaceId}
												section="access"
											/>
											<Divider />
											<WorkspaceDataOwnershipSection
												settings={settings}
												canEdit={canEditSettings}
												workspaceId={workspaceId}
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
											{(livePendingInvites?.length ?? 0) > 0 &&
												` · ${livePendingInvites?.length ?? 0} ${t`pending`}`}
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
												...(hasBillingMembers
													? [{ label: t`Billing`, value: "billing" }]
													: []),
												{ label: t`Members`, value: "members" },
												...(hasExternalMembers
													? [{ label: t`Externals`, value: "externals" }]
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
													seatInviteBlocked ? (
														<Trans>Workspace is full</Trans>
													) : (
														<Trans>Invite people</Trans>
													)
												}
												helperText={
													seatInviteBlocked ? (
														<Trans>
															All seats are taken. Free a seat or upgrade to
															invite more.
														</Trans>
													) : !tierHardBlocks && seatCapHit ? (
														<Trans>
															Each new member is billed per seat on your plan.
														</Trans>
													) : (
														<Trans>
															Invite to this workspace, or just the
															organisation.
														</Trans>
													)
												}
												tooltip={
													seatInviteBlocked ? (
														<Trans>
															All seats are taken on this tier. Remove a member
															or external, or upgrade the workspace tier to
															invite more people.
														</Trans>
													) : undefined
												}
												onClick={openInviteModal}
												disabled={seatInviteBlocked}
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
															color="primary"
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
																{isExternalMember(member) && (
																	<Badge size="xs" variant="light" color="gray">
																		<Trans>External</Trans>
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
																<Badge
																	size="sm"
																	variant="light"
																	color="primary"
																>
																	<Trans>Admin</Trans>
																</Badge>
															</Tooltip>
														) : canManage &&
															member.user_id === myAppUserId &&
															member.role === "admin" &&
															adminLikeCount === 1 ? (
															// Sole admin: lock so they can't strand the workspace by demoting themselves.
															<Tooltip
																label={t`You're the only admin. Promote someone else before changing your role.`}
															>
																<Badge
																	size="sm"
																	variant="light"
																	color="primary"
																>
																	<Trans>Admin</Trans>
																</Badge>
															</Tooltip>
														) : canManage && isExternalMember(member) ? (
															// External row: dropdown locked to "External".
															// Promotion to a member role goes through the
															// org settings page → remove → re-invite flow
															// (ADR-0003). The workspace UI never has a
															// single button that mutates org_membership.
															<Tooltip
																label={t`To promote to a workspace member, add this person to the organisation first, then re-invite from the workspace.`}
																multiline
																w={280}
															>
																<Badge size="sm" variant="light" color="gray">
																	<Trans>External</Trans>
																</Badge>
															</Tooltip>
														) : canManage && member.role === "observer" ? (
															// Observer: locked to a badge. The Select below can't
															// represent "observer" (renders blank) and changing it
															// would turn a free seat into a paid one.
															<Tooltip
																label={t`Observers are free, read-only guests. To give edit access, remove them and re-invite as a member.`}
																multiline
																w={280}
															>
																<Badge size="sm" variant="light" color="gray">
																	<Trans>Observer</Trans>
																</Badge>
															</Tooltip>
														) : canManage ? (
															<Select
																// Matrix §5 retires "Owner" as a user-facing role
																// — only Admin / Billing / Member exposed here.
																// "External" is never an option for a non-external
																// row (ADR-0003): the dropdown is not a
																// cross-boundary lever.
																data={[
																	{ label: t`Member`, value: "member" },
																	{ label: t`Billing`, value: "billing" },
																	{ label: t`Admin`, value: "admin" },
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

								{/* Endpoint is org-admin-only; gate matches AccessRequestsList below. */}
								{canManage && workspaceId && settings.org_id && (
									<PendingInvitesSection
										orgId={settings.org_id}
										scope="workspace"
										workspaceId={workspaceId}
									/>
								)}

								{/* Matrix §6 access requests from organisation members. Hides itself
				    when nothing is pending. */}
								{canManage && workspaceId && (
									<AccessRequestsList
										workspaceId={workspaceId}
										actionedByRole={settings?.my_role ?? "unknown"}
									/>
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

					{/* External view — minimal, no tabs. They can see their own
				    access block + leave affordance, nothing else. */}
					{iAmOutsider && (
						<Stack gap={12}>
							<Title order={5} fw={400}>
								<Trans>Your access</Trans>
							</Title>
							<Group justify="space-between" align="center">
								<Badge size="sm" variant="light" color="yellow">
									<Trans>External</Trans>
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
				<InviteModal
					opened={inviteModalOpened}
					onClose={closeInviteModal}
					orgId={settings.org_id}
					orgName={settings.org_name}
					defaultWorkspaceId={workspaceId}
				/>
			)}
		</>
	);
};

/** `section="general"` renders name + description + logo; `section="access"` renders the Open/Private radio. */
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
	// Description autosaves on blur; privacy keeps explicit Save.
	const [description, setDescription] = useState<string>(
		settings.description ?? "",
	);
	const [name, setName] = useState<string>(settings.name ?? "");
	type Visibility = "open_to_organisation" | "invite_only" | "private";
	const [visibility, setVisibility] = useState<Visibility | null>(null);

	// Tier-gated features open the upgrade modal in place rather than
	// bouncing to the billing tab (page-feedback: upgrade paths are modals).
	const canRequestUpgrade =
		settings.my_role === "owner" ||
		settings.my_role === "admin" ||
		settings.my_role === "billing";
	const [upgradeFeature, setUpgradeFeature] = useState<{
		requiredTier: Tier;
		featureName: string;
		benefit: string;
	} | null>(null);

	const effectiveVisibility: Visibility = visibility ?? settings.visibility;
	const privacyDirty = visibility !== null;

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
			if (visibility === null) return;
			await updateWorkspace(workspaceId, { visibility });
		},
		onError: (err: Error) => toast.error(err.message),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] });
			queryClient.invalidateQueries({
				queryKey: ["v2", "discoverable-workspaces", settings.org_id],
			});
			setVisibility(null);
			toast.success(t`Saved`);
		},
	});

	// Support access is a single boolean; autosave on toggle (no Save button),
	// mirroring how description autosaves. Local state gives instant feedback.
	const [allowSupportAccess, setAllowSupportAccess] = useState<boolean>(
		settings.allow_support_access ?? false,
	);
	const supportAccessMutation = useMutation({
		mutationFn: (value: boolean) =>
			updateWorkspace(workspaceId, { allow_support_access: value }),
		onError: (err: Error) => {
			setAllowSupportAccess(settings.allow_support_access ?? false);
			toast.error(err.message);
		},
		onMutate: (value: boolean) => setAllowSupportAccess(value),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
			toast.success(t`Saved`);
		},
	});

	const logoResetRef = useRef<() => void>(null);
	const [cropSrc, setCropSrc] = useState<string | null>(null);
	const [cropOpened, { open: openCrop, close: closeCrop }] =
		useDisclosure(false);
	const [
		removeLogoConfirmOpened,
		{ open: openRemoveLogoConfirm, close: closeRemoveLogoConfirm },
	] = useDisclosure(false);
	const uploadLogoMutation = useMutation({
		mutationFn: (blob: Blob) =>
			uploadWorkspaceLogo(workspaceId, blob, "logo.png"),
		onError: (err: Error) => toast.error(err.message),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces-context"] });
			toast.success(t`Logo updated`);
		},
	});
	const removeLogoMutation = useMutation({
		mutationFn: () => removeWorkspaceLogo(workspaceId),
		onError: (err: Error) => toast.error(err.message),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspace-settings"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] });
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces-context"] });
			toast.success(t`Logo removed`);
		},
	});

	const currentLogoUrl = logoUrl(settings.logo_url);

	const handleLogoSelect = (file: File | null) => {
		logoResetRef.current?.();
		if (!file) return;
		const reader = new FileReader();
		reader.onload = () => {
			setCropSrc(reader.result as string);
			openCrop();
		};
		reader.readAsDataURL(file);
	};

	const handleCropComplete = (blob: Blob) => {
		uploadLogoMutation.mutate(blob);
		setCropSrc(null);
		closeCrop();
	};

	if (section === "general")
		return (
			<>
				<Stack gap={16}>
					<TextInput
						label={t`Name`}
						description={t`Workspace name. Saves automatically.`}
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
							if (e.key === "Enter")
								(e.currentTarget as HTMLInputElement).blur();
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
							if (e.key === "Enter")
								(e.currentTarget as HTMLInputElement).blur();
							if (e.key === "Escape") {
								setDescription(settings.description ?? "");
								(e.currentTarget as HTMLInputElement).blur();
							}
						}}
						disabled={!canEdit || descriptionMutation.isPending}
						maxLength={500}
					/>
					{(() => {
						// Whitelabel branding is changemaker+ AND a per-workspace logo
						// override is only for external-client workspaces (ISSUE-032);
						// internal workspaces inherit the org's branding.
						const whitelabelTiers = ["changemaker", "guardian"];
						const canWhitelabel =
							whitelabelTiers.includes(settings.tier) &&
							settings.is_external_client;

						if (canWhitelabel) {
							return (
								<Stack gap={6}>
									<Text size="sm" fw={500}>
										<Trans>Logo</Trans>
									</Text>
									<Text size="xs" c="dimmed">
										<Trans>Custom workspace logo shown to participants.</Trans>
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
												onClick={openRemoveLogoConfirm}
											>
												<Trans>Remove</Trans>
											</Button>
										</Group>
									) : (
										<Text size="xs" c="dimmed" fs="italic">
											<Trans>No logo set. dembrane default will be used.</Trans>
										</Text>
									)}
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
													disabled={!canEdit}
													{...props}
												>
													<Trans>Upload logo</Trans>
												</Button>
											)}
										</FileButton>
									)}
								</Stack>
							);
						}

						return (
							<Stack gap={0}>
								<Divider />
								<Group
									justify="space-between"
									align="center"
									gap="xl"
									py="md"
									wrap="nowrap"
								>
									<Stack gap={6}>
										<Text size="sm" fw={500}>
											<Trans>Logo</Trans>
										</Text>
										{currentLogoUrl ? (
											<>
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
														onClick={openRemoveLogoConfirm}
													>
														<Trans>Remove</Trans>
													</Button>
												</Group>
												<Text size="xs" c="dimmed" fs="italic">
													<Trans>
														Your logo is still active but can't be changed on
														this tier.
													</Trans>
												</Text>
											</>
										) : (
											<>
												<Text size="xs" c="dimmed" fs="italic">
													<Trans>
														No logo set. dembrane default will be used.
													</Trans>
												</Text>
												<Button
													variant="light"
													size="compact-sm"
													leftSection={<IconUpload size={14} />}
													style={{ alignSelf: "flex-start" }}
													disabled
												>
													<Trans>Upload logo</Trans>
												</Button>
											</>
										)}
									</Stack>

									<Box
										p="sm"
										style={{
											background: "rgba(65, 105, 225, 0.06)",
											border: "1px solid rgba(65, 105, 225, 0.2)",
											borderRadius: 8,
										}}
									>
										<Stack align="center" gap="xs" maw={260} ta="center">
											<IconLock
												size={24}
												stroke={1.5}
												color="var(--mantine-color-blue-6)"
											/>
											<Text size="sm" fw={600}>
												<Trans>Requires changemaker tier or above</Trans>
											</Text>
											<Button
												size="xs"
												onClick={() =>
													setUpgradeFeature({
														benefit: t`Your brand on every participant screen.`,
														featureName: t`Custom logo`,
														requiredTier: "changemaker",
													})
												}
											>
												<Trans>Upgrade to unlock</Trans>
											</Button>
										</Stack>
									</Box>
								</Group>
								<Divider />
							</Stack>
						);
					})()}
				</Stack>
				{cropSrc && (
					<ImageCropModal
						opened={cropOpened}
						onClose={() => {
							closeCrop();
							setCropSrc(null);
						}}
						imageSrc={cropSrc}
						onCropComplete={handleCropComplete}
						aspect={3}
						title={t`Crop logo`}
					/>
				)}
				<ConfirmModal
					opened={removeLogoConfirmOpened}
					onClose={closeRemoveLogoConfirm}
					onConfirm={() => {
						removeLogoMutation.mutate();
						closeRemoveLogoConfirm();
					}}
					title={t`Remove logo`}
					message={
						<Trans>
							Remove the custom logo? The dembrane default will be used instead.
						</Trans>
					}
					confirmLabel={<Trans>Remove</Trans>}
					confirmColor="red"
					loading={removeLogoMutation.isPending}
					data-testid="workspace-logo-remove-modal"
				/>
				<UpgradeModal
					opened={upgradeFeature !== null}
					onClose={() => setUpgradeFeature(null)}
					currentTier={settings.tier as Tier}
					requiredTier={upgradeFeature?.requiredTier ?? "changemaker"}
					featureName={upgradeFeature?.featureName ?? ""}
					benefit={upgradeFeature?.benefit ?? ""}
					canRequestUpgrade={canRequestUpgrade}
					workspaceId={workspaceId}
				/>
			</>
		);

	// section === "access"
	// Matrix §2: non-open visibility (invite_only / private) is innovator+. The
	// gate fires only when crossing OUT of open; an already-non-open workspace
	// (e.g. migrated invite_only) can switch freely, so disable the non-open
	// options only when currently open on a low tier.
	const privateGateTiers = ["innovator", "changemaker", "guardian"];
	const canGoPrivate = privateGateTiers.includes(settings.tier);
	const currentlyOpen = effectiveVisibility === "open_to_organisation";
	const nonOpenDisabled = !canEdit || (!canGoPrivate && currentlyOpen);
	const upgradeLink = !canGoPrivate && currentlyOpen && (
		<Anchor
			component="button"
			type="button"
			size="xs"
			ta="left"
			style={{ alignSelf: "flex-start" }}
			onClick={(e) => {
				e.preventDefault();
				e.stopPropagation();
				setUpgradeFeature({
					benefit: t`Limit who can find and join this workspace.`,
					featureName: t`Private workspaces`,
					requiredTier: "innovator",
				});
			}}
		>
			<Trans>Available on innovator and above. Upgrade to unlock.</Trans>
		</Anchor>
	);
	return (
		<Stack gap={16}>
			<Radio.Group
				label={t`Access`}
				value={effectiveVisibility}
				onChange={(v) => setVisibility(v as Visibility)}
			>
				<Stack gap={8} mt={4}>
					<Radio
						value="open_to_organisation"
						disabled={!canEdit}
						label={
							<Stack gap={0}>
								<Text size="sm">
									<Trans>Everyone in your organisation</Trans>
								</Text>
								<Text size="xs">
									<Trans>
										Anyone in your organisation can find this workspace. Admins
										can join; members can request access.
									</Trans>
								</Text>
							</Stack>
						}
					/>
					<Radio
						value="invite_only"
						disabled={nonOpenDisabled}
						label={
							<Stack gap={0}>
								<Text size="sm">
									<Trans>Invite only</Trans>
								</Text>
								<Text size="xs">
									<Trans>
										Hidden from organisation members. Organisation admins can
										still find and join.
									</Trans>
								</Text>
								{upgradeLink}
							</Stack>
						}
					/>
					<Radio
						value="private"
						disabled={nonOpenDisabled}
						label={
							<Stack gap={0}>
								<Text size="sm">
									<Trans>Private</Trans>
								</Text>
								<Text size="xs">
									<Trans>
										Hidden from organisation members. Organisation admins can
										still find and join.
									</Trans>
								</Text>
								{upgradeLink}
							</Stack>
						}
					/>
				</Stack>
			</Radio.Group>
			{canEdit && privacyDirty && (
				<Group justify="flex-end">
					<Button
						variant="outline"
						onClick={() => setVisibility(null)}
						disabled={privacyMutation.isPending}
					>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						loading={privacyMutation.isPending}
						onClick={() => privacyMutation.mutate()}
					>
						<Trans>Save access</Trans>
					</Button>
				</Group>
			)}
			<Divider />
			<Switch
				checked={allowSupportAccess}
				disabled={!canEdit || supportAccessMutation.isPending}
				onChange={(e) => supportAccessMutation.mutate(e.currentTarget.checked)}
				label={
					<Stack gap={0}>
						<Text size="sm">
							<Trans>
								Allow dembrane staff to access this workspace for support
							</Trans>
						</Text>
						<Text size="xs">
							<Trans>
								When on, dembrane support staff can join this workspace to help
								you. Their access ends automatically after 24 hours.
							</Trans>
						</Text>
					</Stack>
				}
			/>
			<UpgradeModal
				opened={upgradeFeature !== null}
				onClose={() => setUpgradeFeature(null)}
				currentTier={settings.tier as Tier}
				requiredTier={upgradeFeature?.requiredTier ?? "innovator"}
				featureName={upgradeFeature?.featureName ?? ""}
				benefit={upgradeFeature?.benefit ?? ""}
				canRequestUpgrade={canRequestUpgrade}
				workspaceId={workspaceId}
			/>
		</Stack>
	);
}
