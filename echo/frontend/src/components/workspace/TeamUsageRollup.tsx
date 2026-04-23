import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Badge,
	Group,
	Paper,
	Progress,
	Stack,
	Table,
	Text,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { IconChevronDown, IconChevronRight, IconRefresh } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { API_BASE_URL } from "@/config";
import { PeriodSelect } from "@/components/workspace/PeriodSelect";

interface OrgUsageWorkspaceRow {
	id: string;
	name: string;
	tier: string;
	audio_hours: number;
	hours_included: number | null;
	hours_pct: number | null;
	hours_over: number;
	at_cap: boolean;
	approaching_cap: boolean;
	overage_forecast_eur: number | null;
}

interface OrgUsage {
	cycle_start: string;
	cycle_end_exclusive: string;
	workspace_count: number;
	total_audio_hours: number;
	total_seat_count: number;
	total_guest_count: number;
	total_project_count: number;
	workspaces_at_cap: number;
	workspaces_approaching_cap: number;
	workspaces: OrgUsageWorkspaceRow[];
	total_overage_forecast_eur: number | null;
}

async function fetchOrgUsage(
	orgId: string,
	monthOffset = 0,
	refresh = false,
): Promise<OrgUsage | null> {
	const params = new URLSearchParams();
	if (monthOffset > 0) params.set("month_offset", String(monthOffset));
	if (refresh) params.set("refresh", "true");
	const qs = params.toString();
	const url = `${API_BASE_URL}/v2/orgs/${orgId}/usage${qs ? `?${qs}` : ""}`;
	const res = await fetch(url, { credentials: "include" });
	if (!res.ok) return null;
	return res.json();
}

function formatCycleMonth(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

/**
 * Team-level usage rollup strip (matrix §8 team scope).
 *
 * Rendered at the top of TeamRoute for team admins + billing + members.
 * Members see raw numbers. Admin/billing additionally see aggregate €
 * forecast across all workspaces they bill for (server-gated).
 *
 * Refresh button mirrors the per-workspace UsageCard pattern.
 */
export const TeamUsageRollup = ({ orgId }: { orgId: string }) => {
	const queryClient = useQueryClient();
	const navigate = useI18nNavigate();
	const [refreshing, setRefreshing] = useState(false);
	const [monthOffset, setMonthOffset] = useState(0);

	const { data, isLoading } = useQuery({
		queryKey: ["v2", "org-usage", orgId, monthOffset],
		queryFn: () => fetchOrgUsage(orgId, monthOffset),
		staleTime: 60_000,
	});

	const handleRefresh = async () => {
		setRefreshing(true);
		try {
			const fresh = await fetchOrgUsage(orgId, monthOffset, true);
			if (fresh) {
				queryClient.setQueryData(
					["v2", "org-usage", orgId, monthOffset],
					fresh,
				);
			}
		} finally {
			setRefreshing(false);
		}
	};

	if (isLoading || !data) return null;

	// "Approaching" is a Pilot-only concept per feedback — other tiers
	// just bill overage, there's no "limit" to approach. We only surface
	// at-cap (Pilot hard-block) here.
	const anyWarning = data.workspaces_at_cap > 0;

	return (
		<Paper p="md" withBorder radius="sm">
			<Stack gap={10}>
				<Group justify="space-between" wrap="nowrap" gap="xs">
					<Text size="xs" fw={500} tt="uppercase" c="dimmed" lts={0.5}>
						<Trans>Team usage</Trans>
					</Text>
					<Group gap={6} wrap="nowrap">
						<PeriodSelect value={monthOffset} onChange={setMonthOffset} />
						<Tooltip label={t`Refresh`}>
							<ActionIcon
								variant="subtle"
								color="gray"
								size="sm"
								loading={refreshing}
								onClick={handleRefresh}
								aria-label={t`Refresh team usage`}
							>
								<IconRefresh size={14} />
							</ActionIcon>
						</Tooltip>
					</Group>
				</Group>

				<Group gap="xl" wrap="wrap">
					<Stack gap={0}>
						<Text size="lg" fw={500}>
							{data.total_audio_hours.toFixed(1)}
							<Text span c="dimmed" size="sm">
								{" "}{t`hours`}
							</Text>
						</Text>
						<Text size="xs" c="dimmed">
							<Trans>
								in {formatCycleMonth(data.cycle_start)} · {data.workspace_count}{" "}
								workspaces
							</Trans>
						</Text>
					</Stack>

					<Stack gap={0}>
						<Text size="lg" fw={500}>{data.total_seat_count}</Text>
						<Text size="xs" c="dimmed">
							<Trans>seats</Trans>
						</Text>
					</Stack>

					<Stack gap={0}>
						<Text size="lg" fw={500}>{data.total_guest_count}</Text>
						<Text size="xs" c="dimmed">
							<Trans>guests</Trans>
						</Text>
					</Stack>

					<Stack gap={0}>
						<Text size="lg" fw={500}>{data.total_project_count}</Text>
						<Text size="xs" c="dimmed">
							<Trans>projects</Trans>
						</Text>
					</Stack>

					{/* Overage forecast surface removed per demo feedback —
					    backend still returns the field; UI hides it until we
					    have a clearer "what happens at overage" story. */}
				</Group>

				{anyWarning && (
					<Group gap="xs" mt={4} wrap="nowrap">
						{/* At-limit only fires on Pilot (the only tier with a
						    hard block). Other tiers bill overage and keep going;
						    no warning badge. The per-workspace row below it is
						    always visible now, so we're pointing at a row, not
						    a disclosure. */}
						<Badge size="sm" color="red" variant="light">
							<Plural
								value={data.workspaces_at_cap}
								one="# workspace used up its included hours"
								other="# workspaces used up their included hours"
							/>
						</Badge>
					</Group>
				)}

				{data.workspaces.length > 0 && (
					<Table verticalSpacing="xs" striped highlightOnHover mt={4}>
						<Table.Thead>
							<Table.Tr>
								<Table.Th style={{ width: 28 }} />
								<Table.Th>
									<Text size="xs" c="dimmed">
										<Trans>Workspace</Trans>
									</Text>
								</Table.Th>
								<Table.Th>
									<Text size="xs" c="dimmed">
										<Trans>Tier</Trans>
									</Text>
								</Table.Th>
								<Table.Th style={{ width: 220 }}>
									<Text size="xs" c="dimmed">
										<Trans>Used / Included</Trans>
									</Text>
								</Table.Th>
								<Table.Th style={{ textAlign: "right", width: 100 }}>
									<Text size="xs" c="dimmed">
										<Trans>Over</Trans>
									</Text>
								</Table.Th>
							</Table.Tr>
						</Table.Thead>
						<Table.Tbody>
							{data.workspaces.map((ws) => (
								<WorkspaceRollupRow
									key={ws.id}
									ws={ws}
									monthOffset={monthOffset}
									onOpenBilling={() =>
										navigate(`/w/${ws.id}/settings/billing`)
									}
								/>
							))}
						</Table.Tbody>
					</Table>
				)}
			</Stack>
		</Paper>
	);
};

interface ProjectUsage {
	id: string;
	name: string;
	audio_hours: number;
	conversation_count: number;
}

async function fetchWorkspaceUsage(
	workspaceId: string,
	monthOffset: number,
): Promise<{ projects: ProjectUsage[] } | null> {
	const params = new URLSearchParams();
	if (monthOffset > 0) params.set("month_offset", String(monthOffset));
	const qs = params.toString();
	const url = `${API_BASE_URL}/v2/workspaces/${workspaceId}/usage${qs ? `?${qs}` : ""}`;
	const res = await fetch(url, { credentials: "include" });
	if (!res.ok) return null;
	return res.json();
}

/**
 * Row inside the team-usage table. Chevron reveals the workspace's
 * per-project breakdown. The workspace name itself is a click target
 * into that workspace's billing tab.
 *
 * Project data loads lazily on first expand and shares the same
 * React Query cache key the per-workspace UsageCard uses, so later
 * navigation hits a warm cache.
 */
function WorkspaceRollupRow({
	ws,
	monthOffset,
	onOpenBilling,
}: {
	ws: OrgUsageWorkspaceRow;
	monthOffset: number;
	onOpenBilling: () => void;
}) {
	const [open, setOpen] = useState(false);
	const { data: wsUsage, isLoading } = useQuery({
		queryKey: ["v2", "workspace-usage", ws.id, monthOffset],
		queryFn: () => fetchWorkspaceUsage(ws.id, monthOffset),
		enabled: open,
		staleTime: 60_000,
	});
	const projects = wsUsage?.projects ?? [];

	return (
		<>
			<Table.Tr>
				<Table.Td>
					<ActionIcon
						size="xs"
						variant="subtle"
						color="gray"
						onClick={() => setOpen((v) => !v)}
						aria-label={open ? t`Hide projects` : t`Show projects`}
					>
						{open ? (
							<IconChevronDown size={12} />
						) : (
							<IconChevronRight size={12} />
						)}
					</ActionIcon>
				</Table.Td>
				<Table.Td>
					<Group gap={6} wrap="nowrap">
						{ws.at_cap && (
							<Tooltip label={t`Included hours used up this month`}>
								<Badge size="xs" color="red" variant="light">
									!
								</Badge>
							</Tooltip>
						)}
						{!ws.at_cap && ws.approaching_cap && (
							<Tooltip label={t`80%+ of included hours used this month`}>
								<Badge size="xs" color="yellow" variant="light">
									·
								</Badge>
							</Tooltip>
						)}
						<UnstyledButton
							onClick={onOpenBilling}
							style={{ cursor: "pointer" }}
						>
							<Text size="sm" truncate>
								{ws.name}
							</Text>
						</UnstyledButton>
					</Group>
				</Table.Td>
				<Table.Td>
					<Text size="xs" c="dimmed" style={{ textTransform: "capitalize" }}>
						{ws.tier}
					</Text>
				</Table.Td>
				<Table.Td>
					<Stack gap={2}>
						<Text size="xs">
							{ws.audio_hours.toFixed(1)}
							{ws.hours_included != null && (
								<Text span c="dimmed" size="xs">
									{" / "}
									{ws.hours_included}
								</Text>
							)}
						</Text>
						{ws.hours_pct != null && (
							<Progress
								value={Math.min(100, ws.hours_pct * 100)}
								size="xs"
								color={
									ws.at_cap
										? "red"
										: ws.approaching_cap
											? "yellow"
											: "blue"
								}
							/>
						)}
					</Stack>
				</Table.Td>
				<Table.Td style={{ textAlign: "right" }}>
					<Text size="xs" c={ws.hours_over > 0 ? "red" : "dimmed"}>
						{ws.hours_over > 0 ? `${ws.hours_over.toFixed(1)} h` : "—"}
					</Text>
				</Table.Td>
			</Table.Tr>
			{open && (
				<Table.Tr>
					<Table.Td />
					<Table.Td colSpan={4}>
						{isLoading ? (
							<Text size="xs" c="dimmed" py={4}>
								<Trans>Loading projects…</Trans>
							</Text>
						) : projects.length === 0 ? (
							<Text size="xs" c="dimmed" py={4}>
								<Trans>No project activity this period.</Trans>
							</Text>
						) : (
							<Stack gap={4} py={4}>
								{projects.map((p) => (
									<Group
										key={p.id}
										gap="sm"
										wrap="nowrap"
										justify="space-between"
									>
										<Text size="xs" truncate style={{ flex: 1 }}>
											{p.name || "Untitled"}
										</Text>
										<Text size="xs" c="dimmed">
											<Plural
												value={p.conversation_count}
												one="# conversation"
												other="# conversations"
											/>
										</Text>
										<Text
											size="xs"
											style={{ minWidth: 50, textAlign: "right" }}
										>
											{p.audio_hours.toFixed(1)} h
										</Text>
									</Group>
								))}
							</Stack>
						)}
					</Table.Td>
				</Table.Tr>
			)}
		</>
	);
}
