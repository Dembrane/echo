import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Avatar,
	Badge,
	Box,
	Button,
	Container,
	Group,
	Loader,
	Paper,
	SimpleGrid,
	Stack,
	Text,
	TextInput,
	Title,
	Tooltip,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { IconPlus, IconSettings } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { DiscoverableWorkspaces } from "@/components/workspace/DiscoverableWorkspaces";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useWorkspace } from "@/hooks/useWorkspace";
import { API_BASE_URL, DIRECTUS_PUBLIC_URL } from "@/config";

interface MemberPreview {
	display_name: string;
	avatar: string | null;
}

interface WorkspaceUsage {
	audio_hours: number;
	conversation_count: number;
}

interface Workspace {
	id: string;
	name: string;
	org_id: string;
	org_name: string;
	role: string;
	is_default: boolean;
	tier: string;
	project_count: number;
	member_count: number;
	is_external: boolean;
	members_preview: MemberPreview[];
	usage: WorkspaceUsage;
}

interface TeamRollup {
	id: string;
	name: string;
	role: string;
	total_projects: number;
	total_members: number;
	total_audio_hours: number;
	total_conversations: number;
	workspace_count: number;
}

async function fetchWorkspaces(): Promise<{
	workspaces: Workspace[];
	teams: TeamRollup[];
}> {
	const res = await fetch(`${API_BASE_URL}/v2/workspaces`, {
		credentials: "include",
	});
	if (!res.ok) return { workspaces: [], teams: [] };
	return res.json();
}

function AvatarBubbles({ members, count }: { members: MemberPreview[]; count: number }) {
	const overflow = count - members.length;

	return (
		<Tooltip.Group>
			<Avatar.Group spacing="sm">
				{members.map((m, i) => (
					<Tooltip key={`${m.display_name}-${i}`} label={m.display_name} withArrow>
						<Avatar
							size={28}
							radius="xl"
							src={m.avatar ? `${DIRECTUS_PUBLIC_URL}/assets/${m.avatar}` : null}
							color="blue"
						>
							{m.display_name?.charAt(0)?.toUpperCase()}
						</Avatar>
					</Tooltip>
				))}
				{overflow > 0 && (
					<Avatar size={28} radius="xl" color="gray">
						+{overflow}
					</Avatar>
				)}
			</Avatar.Group>
		</Tooltip.Group>
	);
}

function WorkspaceCard({
	workspace,
	onSelect,
	onManage,
}: { workspace: Workspace; onSelect: () => void; onManage?: () => void }) {
	const isAdminOrOwner = workspace.role === "admin" || workspace.role === "owner";
	const [hovered, setHovered] = useState(false);

	return (
		<Paper
			p="lg"
			radius="md"
			withBorder
			style={{
				cursor: "pointer",
				transition: "box-shadow 0.15s ease, transform 0.15s ease",
				boxShadow: hovered ? "0 2px 12px rgba(0,0,0,0.08)" : undefined,
			}}
			onClick={onSelect}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			onFocus={() => setHovered(true)}
			onBlur={() => setHovered(false)}
		>
			<Stack gap={12}>
				<Group justify="space-between" align="flex-start">
					<Box flex={1}>
						<Text fw={500} size="md" lineClamp={1}>
							{workspace.name}
						</Text>
						{workspace.is_external && (
							<Text size="xs" c="dimmed" mt={4}>
								<Trans>guest of {workspace.org_name}</Trans>
							</Text>
						)}
					</Box>
					<Badge size="xs" variant="light" color="blue">
						{workspace.tier}
					</Badge>
				</Group>

				<Group gap="lg">
					<Text size="xs" c="dimmed">
						{workspace.project_count} {workspace.project_count === 1 ? t`project` : t`projects`}
					</Text>
					<Text size="xs" c="dimmed">
						{workspace.usage.audio_hours}h audio
					</Text>
					<Text size="xs" c="dimmed">
						{workspace.usage.conversation_count} {workspace.usage.conversation_count === 1 ? t`conversation` : t`conversations`}
					</Text>
				</Group>

				<Group justify="space-between" align="center">
					<AvatarBubbles
						members={workspace.members_preview}
						count={workspace.member_count}
					/>
					<Group gap={8}>
						{isAdminOrOwner && onManage && (
							// Manage affordance appears on hover/focus — keeps the resting
							// state calm (designer Ask 5: "⚙ manage shows on row hover").
							<Button
								size="compact-xs"
								variant="subtle"
								color="gray"
								leftSection={<IconSettings size={12} />}
								onClick={(e) => {
									e.stopPropagation();
									onManage();
								}}
								style={{
									opacity: hovered ? 1 : 0,
									transition: "opacity 0.15s ease",
								}}
							>
								<Trans>Manage</Trans>
							</Button>
						)}
						<Text size="xs" c="dimmed" style={{ textTransform: "capitalize" }}>
							{workspace.role}
						</Text>
					</Group>
				</Group>
			</Stack>
		</Paper>
	);
}

/**
 * Dashed placeholder card that lives at the end of each team's workspace
 * grid for admins/owners. Clicking it navigates to /w/new?teamId=<org>
 * so the create form knows which team to create inside.
 *
 * Solves the "create workspace BUT WHERE?" ambiguity — the card sits
 * physically under the team it belongs to, no confusion.
 */
function AddWorkspaceCard({ teamId }: { teamId: string }) {
	const navigate = useI18nNavigate();
	return (
		<Paper
			p="lg"
			radius="md"
			role="button"
			tabIndex={0}
			style={{
				cursor: "pointer",
				border: "1px dashed var(--mantine-color-gray-4)",
				background: "transparent",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				minHeight: 140,
				transition: "border-color 0.15s ease, background 0.15s ease",
			}}
			onMouseEnter={(e) => {
				e.currentTarget.style.borderColor = "var(--mantine-color-blue-5)";
				e.currentTarget.style.background = "rgba(65,105,225,0.03)";
			}}
			onMouseLeave={(e) => {
				e.currentTarget.style.borderColor = "var(--mantine-color-gray-4)";
				e.currentTarget.style.background = "transparent";
			}}
			onClick={() => navigate(`/w/new?teamId=${teamId}`)}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					navigate(`/w/new?teamId=${teamId}`);
				}
			}}
		>
			<Stack gap={6} align="center">
				<IconPlus size={20} style={{ color: "var(--mantine-color-gray-6)" }} />
				<Text size="sm" c="dimmed">
					<Trans>Add workspace</Trans>
				</Text>
			</Stack>
		</Paper>
	);
}

function TeamHeroCard({
	team,
	onManage,
}: {
	team: TeamRollup;
	onManage: () => void;
}) {
	const isAdminOrOwner = team.role === "admin" || team.role === "owner";
	return (
		<Paper
			p="lg"
			radius="md"
			style={{
				background:
					"linear-gradient(135deg, rgba(65,105,225,0.04) 0%, rgba(65,105,225,0.01) 100%)",
				border: "1px solid rgba(65,105,225,0.15)",
			}}
		>
			<Group justify="space-between" align="flex-start">
				<Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
					<Text fw={500} size="lg" lineClamp={1}>
						{team.name}
					</Text>
					<Text size="xs" c="dimmed">
						{team.workspace_count}{" "}
						{team.workspace_count === 1 ? t`workspace` : t`workspaces`} ·{" "}
						{team.total_members}{" "}
						{team.total_members === 1 ? t`person` : t`people`} ·{" "}
						{team.total_projects} {t`projects`}
					</Text>
				</Stack>
				{isAdminOrOwner && (
					<Button
						variant="subtle"
						size="xs"
						color="blue"
						leftSection={<IconSettings size={14} />}
						onClick={onManage}
					>
						<Trans>Manage team</Trans>
					</Button>
				)}
			</Group>
		</Paper>
	);
}

export const WorkspaceSelectorRoute = () => {
	const navigate = useI18nNavigate();
	const { setWorkspace } = useWorkspace();
	const [search, setSearch] = useState("");

	useDocumentTitle(t`Workspaces | dembrane`);

	const { data, isLoading } = useQuery({
		queryKey: ["v2", "workspaces"],
		queryFn: fetchWorkspaces,
		staleTime: 30_000,
	});

	const workspaces = data?.workspaces ?? [];
	const teams = data?.teams ?? [];

	const filtered = search
		? workspaces.filter(
				(w) =>
					w.name.toLowerCase().includes(search.toLowerCase()) ||
					w.org_name.toLowerCase().includes(search.toLowerCase()),
			)
		: workspaces;

	// Group by team (org)
	const internalWorkspaces = filtered.filter((w) => !w.is_external);
	const externalWorkspaces = filtered.filter((w) => w.is_external);

	// Group internal by org
	const orgGroups = new Map<string, { name: string; role: string; workspaces: Workspace[] }>();
	for (const w of internalWorkspaces) {
		const existing = orgGroups.get(w.org_id);
		if (existing) {
			existing.workspaces.push(w);
		} else {
			const team = teams.find((t) => t.id === w.org_id);
			orgGroups.set(w.org_id, {
				name: w.org_name,
				role: team?.role ?? w.role,
				workspaces: [w],
			});
		}
	}

	const handleSelect = (ws: Workspace) => {
		setWorkspace(ws.id);
		navigate(`/w/${ws.id}/projects`);
	};

	if (isLoading) {
		return (
			<Container size="md" py="xl">
				<Stack align="center" gap={16} mt="20vh">
					<Loader size="sm" color="gray" />
				</Stack>
			</Container>
		);
	}

	return (
		<Container size="md" py="xl" px="lg">
				<Stack gap={32}>
					{/* Header — create-workspace is NOT up here. We put
					    "Add workspace" dashed cards inside each team's grid
					    so the placement answers "create where?" by itself. */}
					<Title order={3} fw={400}>
						<Trans>Workspaces</Trans>
					</Title>

					{/* Search (show when >3 workspaces) */}
					{workspaces.length > 3 && (
						<TextInput
							placeholder={t`Search workspaces...`}
							size="sm"
							value={search}
							onChange={(e) => setSearch(e.currentTarget.value)}
						/>
					)}

					{/* Team groups — team hero card tops each group when a rollup
					    exists; falls back to a plain heading otherwise (designer
					    Ask 5: team-level context at top). */}
					{Array.from(orgGroups.entries()).map(([orgId, group]) => {
						const team = teams.find((t) => t.id === orgId);

						return (
							<Stack key={orgId} gap={16}>
								{team ? (
									<TeamHeroCard
										team={team}
										onManage={() => navigate(`/t/${orgId}`)}
									/>
								) : (
									<Text size="sm" fw={500}>
										{group.name}
									</Text>
								)}

								<SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="md">
									{group.workspaces.map((ws) => (
										<WorkspaceCard
											key={ws.id}
											workspace={ws}
											onSelect={() => handleSelect(ws)}
											onManage={() => navigate(`/w/${ws.id}/settings`)}
										/>
									))}
									{/* Dashed "+ new workspace" placeholder — admin/
									    owner only. Lives under the team it belongs
									    to so create-where is answered by placement. */}
									{(group.role === "owner" ||
										group.role === "admin") && (
										<AddWorkspaceCard teamId={orgId} />
									)}
								</SimpleGrid>

								{/* Matrix §6: Slack-style discovery. Renders only
								    when there's something joinable/requestable and
								    hides itself otherwise. */}
								<DiscoverableWorkspaces orgId={orgId} />
							</Stack>
						);
					})}

					{/* External workspaces — quieter section, individual "guest of"
					    labels live on each card (designer Ask 5). */}
					{externalWorkspaces.length > 0 && (
						<Stack gap={12}>
							<Text size="xs" fw={500} c="dimmed" tt="uppercase" lts={0.5}>
								<Trans>As a guest</Trans>
							</Text>
							<SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="md">
								{externalWorkspaces.map((ws) => (
									<WorkspaceCard
										key={ws.id}
										workspace={ws}
										onSelect={() => handleSelect(ws)}
										// External guests don't manage the workspace they visit
										// — suppress the affordance.
										onManage={undefined}
									/>
								))}
							</SimpleGrid>
						</Stack>
					)}

					{/* Empty state */}
					{workspaces.length === 0 && !isLoading && (
						<Stack align="center" gap={16} mt="10vh">
							<Text c="dimmed" size="sm">
								<Trans>No workspaces yet. Create your first one to get started.</Trans>
							</Text>
						</Stack>
					)}
				</Stack>
			</Container>
	);
};
