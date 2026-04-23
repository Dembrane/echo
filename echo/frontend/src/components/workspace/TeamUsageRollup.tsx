import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
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

function formatEur(value: number | null | undefined): string {
	if (value == null) return "—";
	if (value === 0) return "€0";
	return `€${Math.round(value)}`;
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
	const [expanded, setExpanded] = useState(false);
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
						    no warning badge. Click expands the per-workspace
						    breakdown so admins see which pilot is stuck. */}
						<Tooltip label={t`Click to see which`}>
							<Badge
								size="sm"
								color="red"
								variant="light"
								style={{ cursor: "pointer" }}
								onClick={() => setExpanded(true)}
							>
								<Trans>
									{data.workspaces_at_cap} at limit
								</Trans>
							</Badge>
						</Tooltip>
					</Group>
				)}

				{data.workspaces.length > 0 && (
					<Stack gap={6} mt={4}>
						<UnstyledButton
							onClick={() => setExpanded((v) => !v)}
							style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
						>
							{expanded ? (
								<IconChevronDown size={12} />
							) : (
								<IconChevronRight size={12} />
							)}
							<Text size="xs" c="dimmed">
								<Trans>Per-workspace breakdown</Trans>
							</Text>
						</UnstyledButton>
						{expanded && (
							<Table verticalSpacing="xs" striped highlightOnHover>
								<Table.Thead>
									<Table.Tr>
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
										<Table.Th style={{ width: 200 }}>
											<Text size="xs" c="dimmed">
												<Trans>Hours</Trans>
											</Text>
										</Table.Th>
										{data.total_overage_forecast_eur != null && (
											<Table.Th style={{ textAlign: "right" }}>
												<Text size="xs" c="dimmed">
													<Trans>Overage</Trans>
												</Text>
											</Table.Th>
										)}
									</Table.Tr>
								</Table.Thead>
								<Table.Tbody>
									{data.workspaces.map((ws) => (
										<Table.Tr
											key={ws.id}
											style={{ cursor: "pointer" }}
											onClick={() =>
												navigate(`/w/${ws.id}/settings?tab=billing`)
											}
										>
											<Table.Td>
												<Group gap={6} wrap="nowrap">
													{ws.at_cap && (
														<Tooltip label={t`At limit`}>
															<Badge size="xs" color="red" variant="light">
																!
															</Badge>
														</Tooltip>
													)}
													{!ws.at_cap && ws.approaching_cap && (
														<Tooltip label={t`Approaching limit`}>
															<Badge size="xs" color="yellow" variant="light">
																·
															</Badge>
														</Tooltip>
													)}
													<Text size="sm" truncate>
														{ws.name}
													</Text>
												</Group>
											</Table.Td>
											<Table.Td>
												<Text
													size="xs"
													c="dimmed"
													style={{ textTransform: "capitalize" }}
												>
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
											{data.total_overage_forecast_eur != null && (
												<Table.Td style={{ textAlign: "right" }}>
													<Text size="xs">
														{formatEur(ws.overage_forecast_eur)}
													</Text>
												</Table.Td>
											)}
										</Table.Tr>
									))}
								</Table.Tbody>
							</Table>
						)}
					</Stack>
				)}
			</Stack>
		</Paper>
	);
};
