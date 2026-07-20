import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import { Badge, Button, Card, Group, Loader, Stack, Text } from "@mantine/core";
import { IconExternalLink } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { API_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useWorkspace } from "@/hooks/useWorkspace";
import { displayRole, roleColor } from "@/lib/roles";

export interface Workspace {
	id: string;
	name: string;
	org_id: string;
	org_name: string;
	role: string;
	tier: string;
	bills_separately?: boolean;
	project_count: number;
	member_count: number;
}

export interface OrganisationRollup {
	id: string;
	name: string;
	role: string;
	workspace_count: number;
	total_members: number;
	total_projects: number;
}

export interface WorkspacesResponse {
	workspaces: Workspace[];
	organisations: OrganisationRollup[];
}

export async function fetchAccess(): Promise<WorkspacesResponse | null> {
	const res = await fetch(`${API_BASE_URL}/v2/workspaces`, {
		credentials: "include",
	});
	if (!res.ok) return null;
	return res.json();
}

export const useMyAccess = () => {
	return useQuery({
		queryFn: fetchAccess,
		queryKey: ["v2", "workspaces"],
		staleTime: 60_000,
	});
};

/**
 * "My access" card on user settings. Gives the caller a complete read
 * of what they can reach across organisations + workspaces + where they stand
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
	const { setWorkspace } = useWorkspace();
	const { data, isLoading } = useMyAccess();

	// Sync context first so workspace-scoped queries don't lag.
	const openWorkspace = (id: string) => {
		setWorkspace(id);
		navigate(`/w/${id}/home`);
	};

	// Group workspaces under their organisation so the list reads as
	// "organisation → workspaces in that organisation with your role."
	const byOrganisation = useMemo(() => {
		const out = new Map<
			string,
			{ organisation: OrganisationRollup | null; workspaces: Workspace[] }
		>();
		if (!data) return out;
		for (const ws of data.workspaces) {
			const key = ws.org_id || "__orphan__";
			const organisation =
				data.organisations.find((t) => t.id === ws.org_id) ?? null;
			const existing = out.get(key);
			if (existing) existing.workspaces.push(ws);
			else out.set(key, { organisation, workspaces: [ws] });
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

	const totalOrganisations = data?.organisations.length ?? 0;
	const totalWorkspaces = data?.workspaces.length ?? 0;

	return (
		<Card withBorder p="lg" radius="md">
			<Stack gap="lg">
				<Group justify="space-between" align="flex-start" wrap="nowrap">
					<Stack gap={4} style={{ minWidth: 0 }}>
						<Text size="sm" c="dimmed">
							<Plural
								value={totalOrganisations}
								one="# organisation"
								other="# organisations"
							/>
							{" · "}
							<Plural
								value={totalWorkspaces}
								one="# workspace"
								other="# workspaces"
							/>
						</Text>
					</Stack>
				</Group>

				{byOrganisation.size === 0 ? (
					<Text size="sm" c="dimmed" ta="center" py="md">
						<Trans>
							You're not in any organisation yet. Create a workspace to start a
							organisation, or ask a member for an invite.
						</Trans>
					</Text>
				) : (
					<Stack gap="md">
						{Array.from(byOrganisation.values()).map(
							({ organisation, workspaces }) => (
								<Stack key={organisation?.id ?? "orphan"} gap={8}>
									{/* Organisation header sits flush-left so the eye reads
								    "organisation → workspaces" as a hierarchy. Only the
								    workspace rows are indented + rule'd. */}
									<Group gap="xs" justify="space-between" align="center">
										<Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
											<Text fw={500} size="sm" lineClamp={1}>
												{organisation?.name ?? t`(direct workspace access)`}
											</Text>
											{organisation && (
												<Badge
													size="xs"
													variant="light"
													color={roleColor(organisation.role)}
													c="graphite"
												>
													{displayRole(organisation.role)}
												</Badge>
											)}
										</Group>
										{organisation && (
											<Button
												size="compact-xs"
												variant="subtle"
												rightSection={<IconExternalLink size={12} />}
												onClick={() => navigate(`/o/${organisation.id}`)}
											>
												<Trans>Open organisation</Trans>
											</Button>
										)}
									</Group>

									<Stack
										gap={4}
										ml={12}
										style={{
											borderLeft: "2px solid var(--mantine-color-gray-3)",
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
												onClick={() => openWorkspace(ws.id)}
											>
												<Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
													<Text size="sm" lineClamp={1}>
														{ws.name}
													</Text>
													<Badge
														size="xs"
														variant="light"
														color={roleColor(ws.role)}
														c="graphite"
													>
														{displayRole(ws.role)}
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
														{ws.bills_separately
															? `${ws.tier} (partner)`
															: ws.tier}
													</span>
												</Text>
											</Group>
										))}
									</Stack>
								</Stack>
							),
						)}
					</Stack>
				)}
			</Stack>
		</Card>
	);
};
