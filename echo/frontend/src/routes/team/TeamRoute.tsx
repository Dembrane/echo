import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Avatar,
	Badge,
	Box,
	Button,
	Center,
	Container,
	Group,
	Loader,
	Paper,
	SegmentedControl,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { IconLock, IconPlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useParams } from "react-router";
import { API_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";

/**
 * Minimal team (org) page. The heaviest design surface in the
 * workspaces release — this is the deliberately-rough first pass so
 * "Manage team" has somewhere real to land. List + matrix view
 * switcher per designer Ask 1; polish pending.
 */

interface TeamDetail {
	id: string;
	name: string;
	logo_url: string | null;
	role: string;
	member_count: number;
	workspace_count: number;
	external_count: number;
}

interface TeamMember {
	user_id: string;
	app_user_id: string;
	email: string;
	display_name: string;
	avatar: string | null;
	role: string;
	accessible_workspace_count: number;
	is_pending: boolean;
}

interface TeamWorkspace {
	id: string;
	name: string;
	tier: string;
	is_default: boolean;
	project_count: number;
	member_count: number;
	is_private: boolean;
}

async function fetchTeam(teamId: string): Promise<TeamDetail | null> {
	const res = await fetch(`${API_BASE_URL}/v2/orgs/${teamId}`, {
		credentials: "include",
	});
	if (!res.ok) return null;
	return res.json();
}

async function fetchTeamMembers(teamId: string): Promise<TeamMember[]> {
	const res = await fetch(`${API_BASE_URL}/v2/orgs/${teamId}/members`, {
		credentials: "include",
	});
	if (!res.ok) return [];
	return res.json();
}

async function fetchTeamWorkspaces(teamId: string): Promise<TeamWorkspace[]> {
	const res = await fetch(`${API_BASE_URL}/v2/orgs/${teamId}/workspaces`, {
		credentials: "include",
	});
	if (!res.ok) return [];
	return res.json();
}

export const TeamRoute = () => {
	const { teamId } = useParams();
	const navigate = useI18nNavigate();
	const [view, setView] = useState<"members" | "matrix" | "workspaces">(
		"members",
	);

	useDocumentTitle(t`Team | dembrane`);

	const { data: team, isLoading: teamLoading } = useQuery({
		queryKey: ["v2", "team", teamId],
		queryFn: () => fetchTeam(teamId as string),
		enabled: Boolean(teamId),
		staleTime: 30_000,
	});
	const { data: members = [] } = useQuery({
		queryKey: ["v2", "team", teamId, "members"],
		queryFn: () => fetchTeamMembers(teamId as string),
		enabled: Boolean(teamId),
	});
	const { data: workspaces = [] } = useQuery({
		queryKey: ["v2", "team", teamId, "workspaces"],
		queryFn: () => fetchTeamWorkspaces(teamId as string),
		enabled: Boolean(teamId),
	});

	const isAdmin = team?.role === "owner" || team?.role === "admin";

	const internal = useMemo(
		() => members.filter((m) => m.role !== "external"),
		[members],
	);
	const external = useMemo(
		() => members.filter((m) => m.role === "external"),
		[members],
	);

	if (teamLoading) {
		return (
			<Center style={{ height: "60vh" }}>
				<Loader size="sm" color="gray" />
			</Center>
		);
	}

	if (!team) {
		return (
			<Center style={{ height: "60vh" }}>
				<Stack align="center">
					<Title order={3} fw={400}>
						<Trans>Team not found</Trans>
					</Title>
					<Button variant="default" onClick={() => navigate("/w")}>
						<Trans>Back to workspaces</Trans>
					</Button>
				</Stack>
			</Center>
		);
	}

	return (
		<Container size="lg" py="xl" px="lg">
			<Stack gap={24}>
				<Group justify="space-between" align="flex-start">
					<Stack gap={2}>
						<Title order={3} fw={400}>
							{team.name}
						</Title>
						<Text size="sm" c="dimmed">
							{team.workspace_count}{" "}
							{team.workspace_count === 1 ? t`workspace` : t`workspaces`} ·{" "}
							{team.member_count}{" "}
							{team.member_count === 1 ? t`person` : t`people`}
							{team.external_count > 0 ? (
								<> · {team.external_count} {t`guests`}</>
							) : null}
						</Text>
					</Stack>
					{isAdmin && (
						<Button
							size="sm"
							leftSection={<IconPlus size={14} />}
							onClick={() => navigate("/w/new")}
						>
							<Trans>New workspace</Trans>
						</Button>
					)}
				</Group>

				<SegmentedControl
					value={view}
					onChange={(v) => setView(v as typeof view)}
					data={[
						{ value: "members", label: t`Members` },
						{ value: "matrix", label: t`Access matrix` },
						{ value: "workspaces", label: t`Workspaces` },
					]}
				/>

				{view === "members" && (
					<Stack gap="md">
						<Text size="sm" fw={500}>
							<Trans>On the team</Trans>
						</Text>
						<Stack gap={8}>
							{internal.map((m) => (
								<Paper key={m.user_id} p="sm" withBorder radius="md">
									<Group justify="space-between" wrap="nowrap">
										<Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
											<Avatar src={m.avatar ?? undefined} size="sm" radius="xl">
												{(m.display_name || m.email).slice(0, 2).toUpperCase()}
											</Avatar>
											<Stack gap={0} style={{ minWidth: 0 }}>
												<Text size="sm" truncate>
													{m.display_name || m.email || t`Unknown member`}
												</Text>
												<Text size="xs" c="dimmed">
													<Trans>
														Access to {m.accessible_workspace_count} of{" "}
														{team.workspace_count}{" "}
														{team.workspace_count === 1 ? t`workspace` : t`workspaces`}
													</Trans>
												</Text>
											</Stack>
										</Group>
										<Badge
											size="sm"
											variant="light"
											color={m.role === "owner" ? "blue" : "gray"}
											style={{ textTransform: "capitalize" }}
										>
											{m.role}
										</Badge>
									</Group>
								</Paper>
							))}
						</Stack>
						{external.length > 0 && (
							<>
								<Text size="sm" fw={500} c="dimmed" mt="md">
									<Trans>Guests</Trans>
								</Text>
								<Stack gap={8}>
									{external.map((m) => (
										<Paper key={m.user_id} p="sm" withBorder radius="md">
											<Group justify="space-between" wrap="nowrap">
												<Group gap="sm" wrap="nowrap">
													<Avatar src={m.avatar ?? undefined} size="sm" radius="xl">
														{(m.display_name || m.email)
															.slice(0, 2)
															.toUpperCase()}
													</Avatar>
													<Text size="sm">
														{m.display_name || m.email || t`Unknown guest`}
													</Text>
												</Group>
												<Badge size="sm" variant="light" color="gray">
													<Trans>guest</Trans>
												</Badge>
											</Group>
										</Paper>
									))}
								</Stack>
							</>
						)}
					</Stack>
				)}

				{view === "matrix" && (
					<Box style={{ overflowX: "auto" }}>
						<Box
							style={{
								display: "grid",
								gridTemplateColumns: `minmax(200px, 2fr) repeat(${workspaces.length}, minmax(100px, 1fr))`,
								gap: 4,
								fontSize: 12,
							}}
						>
							{/* Header row */}
							<Box />
							{workspaces.map((ws) => (
								<Box
									key={ws.id}
									p={6}
									style={{
										textAlign: "center",
										backgroundColor: "var(--mantine-color-gray-0)",
										borderRadius: 4,
										fontWeight: 500,
									}}
								>
									<Group gap={4} justify="center">
										{ws.is_private && <IconLock size={11} />}
										<Text size="xs" truncate>
											{ws.name}
										</Text>
									</Group>
								</Box>
							))}
							{/* Member rows */}
							{members.map((m) => (
								<>
									<Box
										key={`${m.user_id}-name`}
										p={6}
										style={{
											display: "flex",
											alignItems: "center",
											gap: 8,
											borderRadius: 4,
											backgroundColor: "var(--mantine-color-white)",
											border: "1px solid var(--mantine-color-gray-2)",
										}}
									>
										<Avatar size="xs" radius="xl" src={m.avatar ?? undefined}>
											{(m.display_name || m.email).slice(0, 2).toUpperCase()}
										</Avatar>
										<Text size="xs" truncate style={{ flex: 1, minWidth: 0 }}>
											{m.display_name || m.email}
										</Text>
										<Badge size="xs" variant="light" color="gray">
											{m.role}
										</Badge>
									</Box>
									{workspaces.map((ws) => {
										// Minimal: we don't fetch the (member × workspace) cell
										// role from this endpoint yet. Show a filled cell if the
										// role is admin/owner (team-admin inherits everything
										// non-private), else blank. Matrix precision lives in
										// the workspace's own member list.
										const canAccess =
											m.role === "owner" ||
											(m.role === "admin" && !ws.is_private);
										return (
											<Box
												key={`${m.user_id}-${ws.id}`}
												p={6}
												style={{
													textAlign: "center",
													borderRadius: 4,
													backgroundColor: canAccess
														? "rgba(65,105,225,0.08)"
														: "var(--mantine-color-gray-0)",
													color: canAccess
														? "var(--mantine-color-blue-7)"
														: "var(--mantine-color-gray-5)",
												}}
											>
												{canAccess ? t`admin` : "—"}
											</Box>
										);
									})}
								</>
							))}
						</Box>
						<Text size="xs" c="dimmed" mt="sm">
							<Trans>
								Access shown is derived from team role. Workspace-direct
								invites are managed in each workspace's settings.
							</Trans>
						</Text>
					</Box>
				)}

				{view === "workspaces" && (
					<Stack gap={8}>
						{workspaces.map((ws) => (
							<Paper
								key={ws.id}
								p="sm"
								withBorder
								radius="md"
								style={{ cursor: "pointer" }}
								onClick={() => navigate(`/w/${ws.id}/projects`)}
							>
								<Group justify="space-between" wrap="nowrap">
									<Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
										{ws.is_private && (
											<IconLock
												size={14}
												style={{ color: "var(--mantine-color-gray-6)" }}
												aria-label={t`Private workspace`}
											/>
										)}
										<Stack gap={0} style={{ minWidth: 0 }}>
											<Text size="sm" fw={500} truncate>
												{ws.name}
												{ws.is_default && (
													<Text component="span" size="xs" c="dimmed" ml={6}>
														<Trans>(default)</Trans>
													</Text>
												)}
											</Text>
											<Text size="xs" c="dimmed">
												{ws.project_count} {t`projects`} · {ws.member_count}{" "}
												{t`members`}
											</Text>
										</Stack>
									</Group>
									<Badge size="sm" variant="light" color="blue">
										{ws.tier}
									</Badge>
								</Group>
							</Paper>
						))}
					</Stack>
				)}
			</Stack>
		</Container>
	);
};

export default TeamRoute;
