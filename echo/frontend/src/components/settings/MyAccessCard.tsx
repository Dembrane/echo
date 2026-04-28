import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	Badge,
	Button,
	Card,
	Group,
	Loader,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { IconExternalLink, IconPlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { API_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { displayRole, roleColor } from "@/lib/roles";

interface Workspace {
	id: string;
	name: string;
	org_id: string;
	org_name: string;
	role: string;
	tier: string;
	is_external: boolean;
	project_count: number;
	member_count: number;
}

interface TeamRollup {
	id: string;
	name: string;
	role: string;
	workspace_count: number;
	total_members: number;
	total_projects: number;
}

interface WorkspacesResponse {
	workspaces: Workspace[];
	teams: TeamRollup[];
}

async function fetchAccess(): Promise<WorkspacesResponse | null> {
	const res = await fetch(`${API_BASE_URL}/v2/workspaces`, {
		credentials: "include",
	});
	if (!res.ok) return null;
	return res.json();
}

/**
 * "My access" card on user settings. Gives the caller a complete read
 * of what they can reach across teams + workspaces + where they stand
 * in each. Uses the same /v2/workspaces response the selector uses, so
 * the cache warms the other surface and vice versa.
 *
 * Project-level access is implicit: a workspace membership unlocks
 * every workspace-visible project; direct-project-only access (via
 * project sharing) is rare and the workspace card links let the user
 * drill in when they need per-project detail.
 */
export const MyAccessCard = () => {
	const navigate = useI18nNavigate();
	const { data, isLoading } = useQuery({
		queryKey: ["v2", "workspaces"],
		queryFn: fetchAccess,
		staleTime: 60_000,
	});

	// Group workspaces under their team so the list reads as
	// "team → workspaces in that team with your role."
	const byTeam = useMemo(() => {
		const out = new Map<
			string,
			{ team: TeamRollup | null; workspaces: Workspace[] }
		>();
		if (!data) return out;
		for (const ws of data.workspaces) {
			const key = ws.org_id || "__orphan__";
			const team = data.teams.find((t) => t.id === ws.org_id) ?? null;
			const existing = out.get(key);
			if (existing) existing.workspaces.push(ws);
			else out.set(key, { team, workspaces: [ws] });
		}
		return out;
	}, [data]);

	if (isLoading) {
		return (
			<Card withBorder p="lg">
				<Stack align="center" py="xl">
					<Loader size="sm" color="gray" />
				</Stack>
			</Card>
		);
	}

	const totalTeams = data?.teams.length ?? 0;
	const totalWorkspaces = data?.workspaces.length ?? 0;

	return (
		<Card withBorder p="lg" radius="md">
			<Stack gap="lg">
				<Group justify="space-between" align="flex-start" wrap="nowrap">
					<Stack gap={4} style={{ minWidth: 0 }}>
						<Title order={4} fw={500}>
							<Trans>What you can reach</Trans>
						</Title>
						<Text size="sm" c="dimmed">
							<Plural
								value={totalTeams}
								one="# team"
								other="# teams"
							/>
							{" · "}
							<Plural
								value={totalWorkspaces}
								one="# workspace"
								other="# workspaces"
							/>
						</Text>
					</Stack>
					<Button
						variant="light"
						size="sm"
						leftSection={<IconPlus size={14} />}
						onClick={() => navigate("/w/new")}
					>
						<Trans>New team workspace</Trans>
					</Button>
				</Group>

				{byTeam.size === 0 ? (
					<Text size="sm" c="dimmed" ta="center" py="md">
						<Trans>
							You're not in any team yet. Create a workspace to start a
							team, or ask a teammate for an invite.
						</Trans>
					</Text>
				) : (
					<Stack gap="md">
						{Array.from(byTeam.values()).map(({ team, workspaces }) => (
							<Stack key={team?.id ?? "orphan"} gap={8}>
								{/* Team header sits flush-left so the eye reads
								    "team → workspaces" as a hierarchy. Only the
								    workspace rows are indented + rule'd. */}
								<Group gap="xs" justify="space-between" align="center">
									<Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
										<Text fw={500} size="sm" lineClamp={1}>
											{team?.name ?? t`(direct workspace access)`}
										</Text>
										{team && (
											<Badge
												size="xs"
												variant="light"
												color={roleColor(team.role)}
											>
												{displayRole(team.role)}
											</Badge>
										)}
									</Group>
									{team && (
										<Button
											size="compact-xs"
											variant="subtle"
											rightSection={<IconExternalLink size={12} />}
											onClick={() => navigate(`/t/${team.id}`)}
										>
											<Trans>Open team</Trans>
										</Button>
									)}
								</Group>

								<Stack
									gap={4}
									ml={12}
									style={{
										borderLeft:
											"2px solid var(--mantine-color-gray-3)",
										paddingLeft: 12,
									}}
								>
									{workspaces.map((ws) => (
										<Group
											key={ws.id}
											gap="sm"
											justify="space-between"
											wrap="nowrap"
											style={{ cursor: "pointer" }}
											onClick={() =>
												navigate(`/w/${ws.id}/projects`)
											}
										>
											<Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
												<Text size="sm" lineClamp={1}>
													{ws.name}
												</Text>
												<Badge
													size="xs"
													variant="light"
													color={
														ws.is_external
															? "gray"
															: roleColor(ws.role)
													}
												>
													{ws.is_external
														? t`Guest`
														: displayRole(ws.role)}
												</Badge>
											</Group>
											<Text size="xs" c="dimmed">
												<Plural
													value={ws.project_count}
													one="# project"
													other="# projects"
												/>
												{" · "}
												<span style={{ textTransform: "capitalize" }}>
													{ws.tier}
												</span>
											</Text>
										</Group>
									))}
								</Stack>
							</Stack>
						))}
					</Stack>
				)}
			</Stack>
		</Card>
	);
};
