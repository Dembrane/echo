import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Button,
	Group,
	Paper,
	Progress,
	Stack,
	Table,
	Text,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import {
	IconAlertTriangle,
	IconChevronDown,
	IconChevronRight,
	IconLock,
	IconRefresh,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { API_BASE_URL } from "@/config";
import { PeriodSelect } from "@/components/workspace/PeriodSelect";

interface OrgUsageWorkspaceRow {
	id: string;
	name: string;
	tier: string;
	is_private: boolean;
	audio_hours: number;
	hours_included: number | null;
	hours_pct: number | null;
	hours_over: number;
	seat_count: number;
	seats_included: number | null;
	seats_pct: number | null;
	seat_cap_hit: boolean;
	approaching_seat_cap: boolean;
	downgraded_at: string | null;
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
	// Build the "Needs attention" items. Only surfaces when non-empty —
	// per design note, no empty "all good" state.
	const attention = buildAttention(data.workspaces);

	// Sort by density desc. At-cap first, approaching next, then by
	// combined pct (max of seat/hour). Workspaces with nothing going
	// on sink to the bottom.
	const sortedRows = [...data.workspaces].sort((a, b) => {
		const bucket = (w: OrgUsageWorkspaceRow) =>
			w.at_cap || w.seat_cap_hit
				? 0
				: w.approaching_cap || w.approaching_seat_cap
					? 1
					: 2;
		const ba = bucket(a);
		const bb = bucket(b);
		if (ba !== bb) return ba - bb;
		const densityOf = (w: OrgUsageWorkspaceRow) =>
			Math.max(w.hours_pct ?? 0, w.seats_pct ?? 0);
		return densityOf(b) - densityOf(a);
	});

	return (
		<Paper p="md" withBorder radius="sm">
			<Stack gap={12}>
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

				{attention.length > 0 && (
					<NeedsAttentionPanel items={attention} onOpen={(id) => navigate(`/w/${id}/settings/billing`)} />
				)}

				{/* Single-line team totals — informational, not a quota. */}
				<Text size="sm" c="dimmed">
					<Trans>
						{data.workspace_count} workspaces · {data.total_seat_count} seats ·{" "}
						{data.total_audio_hours.toFixed(1)} hours in{" "}
						{formatCycleMonth(data.cycle_start)}
					</Trans>
				</Text>

				{sortedRows.length > 0 && (
					<Table verticalSpacing="xs" striped highlightOnHover>
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
								<Table.Th style={{ width: 140 }}>
									<Text size="xs" c="dimmed">
										<Trans>Seats</Trans>
									</Text>
								</Table.Th>
								<Table.Th style={{ width: 200 }}>
									<Text size="xs" c="dimmed">
										<Trans>Hours</Trans>
									</Text>
								</Table.Th>
							</Table.Tr>
						</Table.Thead>
						<Table.Tbody>
							{sortedRows.map((ws) => (
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
						{(ws.at_cap || ws.seat_cap_hit) && (
							<Tooltip
								label={
									ws.at_cap
										? t`Included hours used up this month`
										: t`All seats taken`
								}
							>
								<IconAlertTriangle
									size={14}
									color="var(--mantine-color-red-6)"
								/>
							</Tooltip>
						)}
						{!(ws.at_cap || ws.seat_cap_hit) &&
							(ws.approaching_cap || ws.approaching_seat_cap) && (
								<Tooltip label={t`Approaching a limit this month`}>
									<IconAlertTriangle
										size={14}
										color="var(--mantine-color-yellow-7)"
									/>
								</Tooltip>
							)}
						{ws.is_private && (
							<Tooltip label={t`Private workspace`}>
								<IconLock
									size={12}
									color="var(--mantine-color-gray-6)"
								/>
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
					<Text
						size="xs"
						c={ws.seat_cap_hit ? "red" : undefined}
					>
						{ws.seat_count}
						{ws.seats_included != null && (
							<Text span c="dimmed" size="xs">
								{" / "}
								{ws.seats_included}
							</Text>
						)}
					</Text>
				</Table.Td>
				<Table.Td>
					<Stack gap={2}>
						<Text
							size="xs"
							c={ws.at_cap ? "red" : undefined}
						>
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

// ── Needs attention panel ─────────────────────────────────────────────

interface AttentionItem {
	id: string; // workspace id
	key: string; // uniq per (ws, reason) for dismissal
	reason:
		| "seats_full"
		| "seats_near"
		| "hours_full"
		| "hours_near"
		| "recently_downgraded";
	message: string; // pre-formatted, ready to render
	actionLabel: string;
	workspaceId: string;
}

function formatSeatFraction(seat_count: number, seats_included: number | null): string {
	return `${seat_count}/${seats_included ?? "∞"}`;
}

function formatHourFraction(hours: number, cap: number | null): string {
	return cap != null ? `${hours.toFixed(1)}/${cap}h` : `${hours.toFixed(1)}h`;
}

function buildAttention(workspaces: OrgUsageWorkspaceRow[]): AttentionItem[] {
	// One bullet per workspace per reason, severity-ordered. Capped at
	// the caller; we return everything and let the panel decide what to
	// visibly render.
	const out: AttentionItem[] = [];
	const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000;
	const now = Date.now();

	for (const ws of workspaces) {
		if (ws.seat_cap_hit) {
			out.push({
				id: ws.id,
				key: `${ws.id}:seats_full`,
				reason: "seats_full",
				message: `${ws.name} at seat cap (${formatSeatFraction(ws.seat_count, ws.seats_included)})`,
				actionLabel: "Upgrade",
				workspaceId: ws.id,
			});
		} else if (ws.approaching_seat_cap) {
			out.push({
				id: ws.id,
				key: `${ws.id}:seats_near`,
				reason: "seats_near",
				message: `${ws.name} near seat cap (${formatSeatFraction(ws.seat_count, ws.seats_included)})`,
				actionLabel: "Review",
				workspaceId: ws.id,
			});
		}
		if (ws.at_cap) {
			out.push({
				id: ws.id,
				key: `${ws.id}:hours_full`,
				reason: "hours_full",
				message: `${ws.name} at ${ws.tier} hour limit (${formatHourFraction(ws.audio_hours, ws.hours_included)})`,
				actionLabel: "Upgrade",
				workspaceId: ws.id,
			});
		} else if (ws.approaching_cap) {
			out.push({
				id: ws.id,
				key: `${ws.id}:hours_near`,
				reason: "hours_near",
				message: `${ws.name} near ${ws.tier} hour limit (${formatHourFraction(ws.audio_hours, ws.hours_included)})`,
				actionLabel: "Review",
				workspaceId: ws.id,
			});
		}
		if (ws.downgraded_at) {
			const dtMs = new Date(ws.downgraded_at).getTime();
			if (!Number.isNaN(dtMs) && now - dtMs < SEVEN_DAYS_MS) {
				out.push({
					id: ws.id,
					key: `${ws.id}:recently_downgraded`,
					reason: "recently_downgraded",
					message: `${ws.name} was downgraded recently — verify limits`,
					actionLabel: "Review",
					workspaceId: ws.id,
				});
			}
		}
	}
	return out;
}

const MAX_ATTENTION_VISIBLE = 4;

function NeedsAttentionPanel({
	items,
	onOpen,
}: {
	items: AttentionItem[];
	onOpen: (workspaceId: string) => void;
}) {
	const [showAll, setShowAll] = useState(false);
	const visible = showAll ? items : items.slice(0, MAX_ATTENTION_VISIBLE);
	const hidden = items.length - visible.length;

	return (
		<Paper
			withBorder
			p="sm"
			radius="sm"
			style={{ borderColor: "var(--mantine-color-yellow-3)" }}
		>
			<Stack gap={6}>
				<Group gap="xs" wrap="nowrap">
					<IconAlertTriangle
						size={14}
						color="var(--mantine-color-yellow-7)"
					/>
					<Text size="xs" fw={500} tt="uppercase" lts={0.5}>
						<Trans>Needs attention</Trans>
					</Text>
				</Group>
				<Stack gap={4}>
					{visible.map((item) => (
						<Group
							key={item.key}
							gap="xs"
							wrap="nowrap"
							justify="space-between"
						>
							<Text size="sm" style={{ flex: 1 }} lineClamp={1}>
								{item.message}
							</Text>
							<Button
								size="compact-xs"
								variant="light"
								color="gray"
								onClick={() => onOpen(item.workspaceId)}
							>
								{item.actionLabel}
							</Button>
						</Group>
					))}
				</Stack>
				{hidden > 0 && !showAll && (
					<UnstyledButton onClick={() => setShowAll(true)}>
						<Text size="xs" c="dimmed">
							<Trans>Show {hidden} more</Trans>
						</Text>
					</UnstyledButton>
				)}
			</Stack>
		</Paper>
	);
}
