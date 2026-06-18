import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	Avatar,
	Badge,
	Box,
	Group,
	Loader,
	Paper,
	Stack,
	Text,
	Title,
	Tooltip,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { UsageFreshness } from "@/components/common/UsageFreshness";
import { InviteMemberCard, MembersToolbar } from "@/components/members";
import { API_BASE_URL } from "@/config";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useV2Me } from "@/hooks/useV2Me";
import { useProjectShares } from "@/hooks/useProjectSharing";
import { avatarUrl, memberInitials } from "@/lib/avatar";
import { displayRole, isAdminRole } from "@/lib/roles";
import { formatDurationFromHours } from "@/lib/time";
import { ProjectSharingModal } from "./ProjectSharingModal";
import { ProjectSharingStrip } from "./ProjectSharingStrip";

interface WorkspaceProjectUsage {
	id: string;
	name: string;
	audio_hours: number;
	conversation_count: number;
}

interface WorkspaceUsageResponse {
	tier: string;
	tier_tagline: string;
	projects: WorkspaceProjectUsage[];
}

interface WorkspaceSettingsMember {
	id: string;
	user_id: string;
	display_name: string;
	email: string;
	avatar: string | null;
	role: string;
	source: string;
}

interface WorkspaceSettingsResponse {
	members: WorkspaceSettingsMember[];
}

async function fetchWorkspaceUsage(
	workspaceId: string,
): Promise<WorkspaceUsageResponse | null> {
	const res = await fetch(
		`${API_BASE_URL}/v2/workspaces/${workspaceId}/usage`,
		{ credentials: "include" },
	);
	if (!res.ok) return null;
	return res.json();
}

interface ConversationUsageRow {
	id: string;
	title: string | null;
	hours: number;
	is_deleted: boolean;
}

interface ConversationUsageResponse {
	active: ConversationUsageRow[];
	deleted: ConversationUsageRow[];
	total_hours: number;
	active_hours: number;
	deleted_hours: number;
}

async function fetchConversationUsage(
	projectId: string,
): Promise<ConversationUsageResponse | null> {
	const res = await fetch(
		`${API_BASE_URL}/v2/projects/${projectId}/conversation-usage`,
		{ credentials: "include" },
	);
	if (!res.ok) return null;
	return res.json();
}

async function fetchWorkspaceSettings(
	workspaceId: string,
): Promise<WorkspaceSettingsResponse | null> {
	const res = await fetch(
		`${API_BASE_URL}/v2/workspaces/${workspaceId}/settings`,
		{ credentials: "include" },
	);
	if (!res.ok) return null;
	return res.json();
}

interface Props {
	projectId: string;
	visibility: "workspace" | "private";
}

export function ProjectAccess({ projectId, visibility }: Props) {
	const { workspaceId, workspace } = useWorkspace();
	const { data: meV2 } = useV2Me();
	const myAppUserId = meV2?.id ?? null;
	const { data: shares, isLoading: sharesLoading } = useProjectShares(projectId);
	const [memberSearch, setMemberSearch] = useState("");
	const [memberFilter, setMemberFilter] = useState<
		"all" | "admins" | "members" | "externals"
	>("all");
	const [inviteOpen, setInviteOpen] = useState(false);

	const isWorkspaceVisible = visibility === "workspace";

	const { data: wsSettings, isLoading: membersLoading } = useQuery({
		queryKey: ["v2", "workspace-settings", workspaceId],
		queryFn: () => (workspaceId ? fetchWorkspaceSettings(workspaceId) : null),
		enabled: Boolean(workspaceId && isWorkspaceVisible),
		staleTime: 60_000,
	});

	type AccessRow = {
		key: string;
		user_id: string;
		display_name: string;
		email: string;
		avatar: string | null;
		role: string;
		is_external?: boolean;
	};

	const accessRows: AccessRow[] = isWorkspaceVisible
		? ROLE_SORT(
				(wsSettings?.members ?? []).map((m) => ({
					key: m.id,
					user_id: m.user_id,
					display_name: m.display_name,
					email: m.email,
					avatar: m.avatar,
					role: m.role,
					is_external: m.role === "external",
				})),
			)
		: (shares ?? []).map((s) => ({
				key: s.user_id,
				user_id: s.user_id,
				display_name: s.display_name,
				email: s.email,
				avatar: s.avatar,
				role: s.role,
			}));

	const accessCount = accessRows.length;
	const accessLoading = isWorkspaceVisible ? membersLoading : sharesLoading;
	const hasGuestRows = useMemo(
		() => accessRows.some((r) => r.is_external),
		[accessRows],
	);
	const filteredAccessRows = useMemo(() => {
		const q = memberSearch.trim().toLowerCase();
		return accessRows.filter((r) => {
			if (memberFilter === "admins") {
				if (r.is_external) return false;
				if (!(r.role === "owner" || r.role === "admin")) return false;
			}
			if (memberFilter === "members") {
				if (r.is_external) return false;
				if (r.role === "owner" || r.role === "admin") return false;
			}
			if (memberFilter === "externals" && !r.is_external) return false;
			if (!q) return true;
			return (
				(r.display_name || "").toLowerCase().includes(q) ||
				(r.email || "").toLowerCase().includes(q)
			);
		});
	}, [accessRows, memberSearch, memberFilter]);

	return (
		<Stack gap="lg">
			<Stack gap={4}>
				<Title order={4} fw={500}>
					<Trans>Access</Trans>
				</Title>
				<Text size="sm" c="dimmed">
					<Trans>
						Who can see and collaborate on this project.
					</Trans>
				</Text>
			</Stack>

			<ProjectSharingStrip
				projectId={projectId}
				visibility={visibility}
				workspaceName={workspace?.name ?? undefined}
			/>

			<Stack gap="md">
				<Group justify="space-between" align="center">
					<Title order={5} fw={400}>
						<Trans>Members</Trans>
					</Title>
					<Text size="xs" c="dimmed">
						{accessLoading ? (
							<Trans>Loading…</Trans>
						) : isWorkspaceVisible ? (
							<Trans>
								<Plural
									value={accessCount}
									one="# person"
									other="# people"
								/>{" "}
								in {workspace?.name ?? t`this workspace`}
							</Trans>
						) : accessCount === 0 ? (
							<Trans>Just you — plus workspace admins.</Trans>
						) : (
							<>
								<Plural
									value={accessCount}
									one="# person"
									other="# people"
								/>
								{" · "}
								<Trans>plus workspace admins</Trans>
							</>
						)}
					</Text>
				</Group>

				<MembersToolbar
					search={memberSearch}
					onSearchChange={setMemberSearch}
					filter={{
						value: memberFilter,
						onChange: (v) =>
							setMemberFilter(v as typeof memberFilter),
						options: [
							{ value: "all", label: t`All` },
							{ value: "admins", label: t`Admins` },
							{ value: "members", label: t`Members` },
							...(hasGuestRows
								? [{ value: "externals", label: t`Externals` }]
								: []),
						],
					}}
					count={{
						shown: filteredAccessRows.length,
						total: accessCount,
					}}
				/>

				<Stack gap="xs">
					{!isWorkspaceVisible && isAdminRole(workspace?.role) && (
						<InviteMemberCard
							label={<Trans>Share with someone</Trans>}
							helperText={<Trans>Add a member and pick their access.</Trans>}
							onClick={() => setInviteOpen(true)}
						/>
					)}

					{accessLoading ? (
						<Loader size="xs" />
					) : accessRows.length === 0 ? (
						<Paper withBorder p="md" radius="md">
							<Text size="sm" c="dimmed">
								{isWorkspaceVisible ? (
									<Trans>No one's on the workspace yet.</Trans>
								) : (
									<Trans>
										No explicit shares. Workspace admins still have access.
									</Trans>
								)}
							</Text>
						</Paper>
					) : (
						filteredAccessRows.map((row) => (
							<Paper key={row.key} withBorder p="md" radius="md">
								<Group
									justify="space-between"
									align="center"
									wrap="nowrap"
								>
									<Group
										gap={10}
										wrap="nowrap"
										style={{ minWidth: 0 }}
									>
										<Avatar
											size={32}
											radius="xl"
											src={avatarUrl(row.avatar, 48)}
										>
											{memberInitials(row.display_name, row.email)}
										</Avatar>
										<Box style={{ minWidth: 0 }}>
											<Group gap={6} wrap="nowrap">
												<Text size="sm" fw={500} lineClamp={1}>
													{row.display_name || row.email}
													{row.user_id === myAppUserId && (
														<Text component="span" c="dimmed" fw={400}>
															{" "}
															<Trans>(You)</Trans>
														</Text>
													)}
												</Text>
												{row.is_external && (
													<Badge
														size="xs"
														variant="light"
														color="gray"
													>
														<Trans>External</Trans>
													</Badge>
												)}
											</Group>
											{row.email &&
												row.email !== row.display_name && (
													<Text
														size="xs"
														c="dimmed"
														lineClamp={1}
													>
														{row.email}
													</Text>
												)}
										</Box>
									</Group>
									<Badge
										size="xs"
										variant="light"
										color="gray"
										style={{ textTransform: "capitalize" }}
									>
										{displayRole(row.role)}
									</Badge>
								</Group>
							</Paper>
						))
					)}
					{!accessLoading &&
						accessRows.length > 0 &&
						filteredAccessRows.length === 0 && (
							<Text size="sm" c="dimmed" ta="center" py="md">
								<Trans>No one matches that filter.</Trans>
							</Text>
						)}
				</Stack>
			</Stack>

			<ProjectSharingModal
				projectId={projectId}
				opened={inviteOpen}
				visibility={visibility}
				workspaceName={workspace?.name ?? undefined}
				onClose={() => setInviteOpen(false)}
			/>
		</Stack>
	);
}

export function ProjectUsage({ projectId }: { projectId: string }) {
	const { workspaceId } = useWorkspace();

	const {
		data: usage,
		isLoading: usageLoading,
		dataUpdatedAt: usageUpdatedAt,
		refetch: refetchUsage,
	} = useQuery({
		queryKey: ["v2", "workspace-usage", workspaceId, 0],
		queryFn: () => (workspaceId ? fetchWorkspaceUsage(workspaceId) : null),
		enabled: Boolean(workspaceId),
		staleTime: 60_000,
	});

	const {
		data: convUsage,
		dataUpdatedAt: convUsageUpdatedAt,
		refetch: refetchConvUsage,
	} = useQuery({
		queryKey: ["v2", "project-conv-usage", projectId],
		queryFn: () => fetchConversationUsage(projectId),
		enabled: Boolean(projectId),
		staleTime: 60_000,
	});

	const usageDataUpdatedAt = Math.min(
		usageUpdatedAt || Date.now(),
		convUsageUpdatedAt || Date.now(),
	);
	const [usageRefreshing, setUsageRefreshing] = useState(false);
	const handleUsageRefresh = async () => {
		setUsageRefreshing(true);
		try {
			await Promise.all([refetchUsage(), refetchConvUsage()]);
		} finally {
			setUsageRefreshing(false);
		}
	};

	const projectUsage = usage?.projects?.find((p) => p.id === projectId) ?? null;

	return (
		<Stack gap="lg">
			<Stack gap={4}>
				<Title order={4} fw={500}>
					<Trans>Usage</Trans>
				</Title>
				<Text size="sm" c="dimmed">
					<Trans>
						What this project is consuming this cycle.
					</Trans>
				</Text>
			</Stack>

			<Paper withBorder p="md" radius="sm">
				<Stack gap="sm">
					<Group justify="space-between" align="center">
						<Text size="sm" fw={500}>
							<Trans>Usage this cycle</Trans>
						</Text>
						{usage?.tier && (
							<Badge size="sm" variant="light" color="gray">
								<span style={{ textTransform: "capitalize" }}>
									{usage.tier}
								</span>
							</Badge>
						)}
					</Group>

					{usageLoading && !projectUsage && <Loader size="xs" />}

					{!usageLoading && projectUsage && (
						<Group gap="xl">
							<Stack gap={2}>
								<Text size="xs" c="dimmed">
									<Trans>Audio</Trans>
								</Text>
								<Text size="lg" fw={500}>
									{formatDurationFromHours(projectUsage.audio_hours)}
								</Text>
							</Stack>
							<Stack gap={2}>
								<Text size="xs" c="dimmed">
									<Trans>Conversations</Trans>
								</Text>
								<Text size="lg" fw={500}>
									{projectUsage.conversation_count}
								</Text>
							</Stack>
						</Group>
					)}

					{!usageLoading && !projectUsage && (
						<Text size="sm" c="dimmed">
							<Trans>No usage yet this cycle.</Trans>
						</Text>
					)}

					{convUsage && convUsage.total_hours > 0 && (
						<Stack gap={6} mt={4}>
							<Text size="xs" c="dimmed">
								<Trans>
									Breakdown · {convUsage.active.length} active
								</Trans>
								{convUsage.deleted.length > 0 && (
									<>
										{" · "}
										<Trans>
											{convUsage.deleted.length} deleted
										</Trans>
									</>
								)}
							</Text>
							<Box
								style={{
									display: "flex",
									height: 10,
									borderRadius: 4,
									overflow: "hidden",
									background: "var(--mantine-color-gray-1)",
								}}
							>
								{convUsage.active.map((row) => {
									const pct = (row.hours / convUsage.total_hours) * 100;
									if (pct <= 0) return null;
									return (
										<Tooltip
											key={row.id}
											label={
												<Stack gap={0}>
													<Text size="xs" fw={500}>
														{row.title || t`Untitled conversation`}
													</Text>
													<Text size="xs">
														{formatDurationFromHours(row.hours)}
													</Text>
												</Stack>
											}
											withArrow
										>
											<Box
												style={{
													width: `${pct}%`,
													background: "var(--mantine-color-blue-5)",
													borderRight: "1px solid white",
												}}
											/>
										</Tooltip>
									);
								})}
								{convUsage.deleted_hours > 0 && (
									<Tooltip
										label={
											<Stack gap={4} style={{ maxHeight: 240, overflow: "hidden" }}>
												<Text size="xs" fw={500}>
													<Trans>Deleted · {formatDurationFromHours(convUsage.deleted_hours)}</Trans>
												</Text>
												{convUsage.deleted.slice(0, 8).map((d) => (
													<Text key={d.id} size="xs">
														{d.title || t`Untitled conversation`}
														{" · "}
														{formatDurationFromHours(d.hours)}
													</Text>
												))}
												{convUsage.deleted.length > 8 && (
													<Text size="xs" c="dimmed">
														<Trans>
															+{convUsage.deleted.length - 8} more
														</Trans>
													</Text>
												)}
											</Stack>
										}
										withArrow
										position="top"
									>
										<Box
											style={{
												width: `${(convUsage.deleted_hours / convUsage.total_hours) * 100}%`,
												background: "var(--mantine-color-gray-5)",
											}}
										/>
									</Tooltip>
								)}
							</Box>
							<Group gap={14} wrap="wrap">
								<Group gap={6} wrap="nowrap">
									<Box
										style={{
											width: 8,
											height: 8,
											borderRadius: 2,
											background: "var(--mantine-color-blue-5)",
										}}
									/>
									<Text size="xs" c="dimmed">
										<Trans>Active · {formatDurationFromHours(convUsage.active_hours)}</Trans>
									</Text>
								</Group>
								{convUsage.deleted_hours > 0 && (
									<Group gap={6} wrap="nowrap">
										<Box
											style={{
												width: 8,
												height: 8,
												borderRadius: 2,
												background: "var(--mantine-color-gray-5)",
											}}
										/>
										<Text size="xs" c="dimmed">
											<Trans>Deleted · {formatDurationFromHours(convUsage.deleted_hours)}</Trans>
										</Text>
									</Group>
								)}
							</Group>
						</Stack>
					)}
					<UsageFreshness
						dataUpdatedAt={usageDataUpdatedAt}
						refreshing={usageRefreshing}
						onRefresh={handleUsageRefresh}
					/>
				</Stack>
			</Paper>
		</Stack>
	);
}

const ROLE_WEIGHT: Record<string, number> = {
	owner: 0,
	admin: 1,
	billing: 2,
	member: 3,
	viewer: 4,
	editor: 3,
};
function ROLE_SORT<T extends { role: string; display_name: string; email: string; is_external?: boolean }>(
	rows: T[],
): T[] {
	return [...rows].sort((a, b) => {
		const aExt = a.is_external ? 1 : 0;
		const bExt = b.is_external ? 1 : 0;
		if (aExt !== bExt) return aExt - bExt;
		const ar = ROLE_WEIGHT[a.role] ?? 99;
		const br = ROLE_WEIGHT[b.role] ?? 99;
		if (ar !== br) return ar - br;
		return (a.display_name || a.email || "").localeCompare(
			b.display_name || b.email || "",
		);
	});
}
