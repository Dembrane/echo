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
}: { workspace: Workspace; onSelect: () => void }) {
	return (
		<Paper
			p="lg"
			radius="md"
			withBorder
			style={{ cursor: "pointer", transition: "box-shadow 0.15s ease" }}
			onClick={onSelect}
			onMouseOver={(e) => { (e.currentTarget as HTMLElement).style.boxShadow = "0 2px 12px rgba(0,0,0,0.08)"; }}
			onMouseOut={(e) => { (e.currentTarget as HTMLElement).style.boxShadow = "none"; }}
		>
			<Stack gap={12}>
				<Group justify="space-between" align="flex-start">
					<Box flex={1}>
						<Text fw={500} size="md" lineClamp={1}>
							{workspace.name}
						</Text>
						{workspace.is_external && (
							<Badge size="xs" variant="light" color="gray" mt={4}>
								<Trans>External</Trans>
							</Badge>
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
					<Text size="xs" c="dimmed">
						{workspace.role}
					</Text>
				</Group>
			</Stack>
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
		setWorkspace(ws.id, ws.name);
		navigate("/projects");
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
					{/* Header */}
					<Group justify="space-between" align="flex-end">
						<Title order={3} fw={400}>
							<Trans>Workspaces</Trans>
						</Title>
						<Button
							size="sm"
							leftSection={<IconPlus size={16} />}
							onClick={() => navigate("/workspaces/new")}
						>
							<Trans>New workspace</Trans>
						</Button>
					</Group>

					{/* Search (show when >3 workspaces) */}
					{workspaces.length > 3 && (
						<TextInput
							placeholder={t`Search workspaces...`}
							size="sm"
							value={search}
							onChange={(e) => setSearch(e.currentTarget.value)}
						/>
					)}

					{/* Team groups */}
					{Array.from(orgGroups.entries()).map(([orgId, group]) => {
						const team = teams.find((t) => t.id === orgId);

						return (
							<Stack key={orgId} gap={16}>
								<Group justify="space-between" align="center">
									<Group gap={8}>
										<Text size="sm" fw={500}>
											{group.name}
										</Text>
										{team && (
											<Text size="xs" c="dimmed">
												{team.total_projects} {t`projects`} · {team.total_members} {t`members`} · {team.total_audio_hours}h
											</Text>
										)}
									</Group>
									{(group.role === "owner" || group.role === "admin") && (
										<Button
											variant="subtle"
											size="xs"
											color="gray"
											leftSection={<IconSettings size={14} />}
										>
											<Trans>Manage</Trans>
										</Button>
									)}
								</Group>

								<SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="md">
									{group.workspaces.map((ws) => (
										<WorkspaceCard
											key={ws.id}
											workspace={ws}
											onSelect={() => handleSelect(ws)}
										/>
									))}
								</SimpleGrid>
							</Stack>
						);
					})}

					{/* External workspaces */}
					{externalWorkspaces.length > 0 && (
						<Stack gap={16}>
							<Text size="sm" fw={500} c="dimmed">
								<Trans>External</Trans>
							</Text>
							<SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="md">
								{externalWorkspaces.map((ws) => (
									<WorkspaceCard
										key={ws.id}
										workspace={ws}
										onSelect={() => handleSelect(ws)}
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
