import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Badge,
	Box,
	Button,
	Checkbox,
	Group,
	Menu,
	MultiSelect,
	Paper,
	Progress,
	Stack,
	Table,
	Text,
	TextInput,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import {
	IconAdjustments,
	IconAlertTriangle,
	IconArrowsSort,
	IconChevronDown,
	IconChevronRight,
	IconLock,
	IconSearch,
	IconSortAscending,
	IconSortDescending,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	type ColumnDef,
	flexRender,
	getCoreRowModel,
	getFilteredRowModel,
	getSortedRowModel,
	type SortingState,
	useReactTable,
	type VisibilityState,
} from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { toast } from "@/components/common/Toaster";
import { UsageFreshness } from "@/components/common/UsageFreshness";
import { PeriodSelect } from "@/components/workspace/PeriodSelect";
import { API_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { formatDurationFromHours } from "@/lib/time";

const TIER_ORDER = [
	"pilot",
	"pioneer",
	"innovator",
	"changemaker",
	"guardian",
] as const;
const tierRank = (tier: string): number =>
	TIER_ORDER.indexOf(tier as (typeof TIER_ORDER)[number]);

const tierColors: Record<string, string> = {
	changemaker: "grape",
	guardian: "orange",
	innovator: "violet",
	pilot: "gray",
	pioneer: "primary",
};

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
	external_count: number;
	// Free, read-only observers — not part of seat_count (Wave G).
	observer_count: number;
	downgraded_at: string | null;
	at_cap: boolean;
	approaching_cap: boolean;
	// Billed on its own (workspace-scoped) account, not the org's pooled plan.
	bills_separately: boolean;
}

interface OrgUsage {
	cycle_start: string;
	cycle_end_exclusive: string;
	workspace_count: number;
	total_audio_hours: number;
	total_seat_count: number;
	total_external_count: number;
	// Free, read-only observers across all workspaces (not in seat total).
	total_observer_count: number;
	total_project_count: number;
	workspaces_at_cap: number;
	workspaces_approaching_cap: number;
	workspaces: OrgUsageWorkspaceRow[];
}

// Active = any activity this period. Matches the admin surface. Hoisted
// to module scope so it's a stable reference for the useMemo dep arrays
// below — defining inline would trigger react-hooks/exhaustive-deps and
// re-allocate on every render for no reason.
const isActive = (w: OrgUsageWorkspaceRow): boolean =>
	w.audio_hours > 0 || w.seat_count > 0;

async function fetchOrgUsage(
	orgId: string,
	monthOffset = 0,
	refresh = false,
): Promise<OrgUsage> {
	const params = new URLSearchParams();
	if (monthOffset > 0) params.set("month_offset", String(monthOffset));
	if (refresh) params.set("refresh", "true");
	const qs = params.toString();
	const url = `${API_BASE_URL}/v2/orgs/${orgId}/usage${qs ? `?${qs}` : ""}`;
	const res = await fetch(url, { credentials: "include" });
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(
			typeof data.detail === "string"
				? data.detail
				: t`Couldn't load usage (${res.status})`,
		);
	}
	return res.json();
}

function formatCycleMonth(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

/**
 * Inline usage bar. Green under 60 percent, yellow 60 to 90, red over
 * 90. Shows N / cap as text above the bar. When cap is null we render
 * the raw count with no bar (guardian unlimited).
 */
function UsageBar({
	used,
	cap,
	unit = "",
	block,
}: {
	used: number;
	cap: number | null;
	unit?: string;
	block?: boolean;
}) {
	if (cap == null) {
		return (
			<Text size="xs" c="dimmed">
				{used.toFixed(unit === "h" ? 1 : 0)}
				{unit ? ` ${unit}` : ""}
			</Text>
		);
	}
	const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
	const color = block
		? "red"
		: pct >= 100
			? "red"
			: pct >= 90
				? "red"
				: pct >= 60
					? "yellow"
					: "green";
	return (
		<Stack gap={2}>
			<Text size="xs" c={color === "red" ? "red" : undefined}>
				{used.toFixed(unit === "h" ? 1 : 0)} / {cap}
				{unit ? ` ${unit}` : ""}
			</Text>
			<Progress value={pct} color={color} size="xs" radius="xs" />
		</Stack>
	);
}

function SortableHeader({
	label,
	sorted,
}: {
	label: string;
	sorted: false | "asc" | "desc";
}) {
	return (
		<Group gap={4} wrap="nowrap">
			<Text
				size="xs"
				fw={sorted ? 600 : 500}
				c={sorted ? "dark" : "dimmed"}
				tt="uppercase"
				lts={0.3}
			>
				{label}
			</Text>
			{sorted === "asc" ? (
				<IconSortAscending size={12} color="var(--mantine-color-dark-6)" />
			) : sorted === "desc" ? (
				<IconSortDescending size={12} color="var(--mantine-color-dark-6)" />
			) : (
				<IconArrowsSort
					size={12}
					color="var(--mantine-color-gray-4)"
					aria-hidden
				/>
			)}
		</Group>
	);
}

/**
 * Organisation-level usage rollup (matrix §8 organisation scope).
 *
 * Rendered on the Organisation settings Usage and Tier tab for organisation admins +
 * billing + members. Members see raw numbers; admin/billing see the
 * same (this table intentionally hides euro amounts — the admin
 * surface at /admin is where price/overage figures live).
 *
 * Table uses TanStack so it matches the fidelity of the admin panel:
 * sortable columns with a matrix-order tier sort, text search, tier
 * filter, status filter, column visibility, inline progress bars,
 * per-project drill-down on expand.
 */
export const OrganisationUsageRollup = ({ orgId }: { orgId: string }) => {
	const queryClient = useQueryClient();
	const navigate = useI18nNavigate();
	const [refreshing, setRefreshing] = useState(false);
	const [monthOffset, setMonthOffset] = useState(0);
	const [globalFilter, setGlobalFilter] = useState("");
	const [tierFilter, setTierFilter] = useState<string[]>([]);
	const [statusFilter, setStatusFilter] = useState<
		"all" | "active" | "inactive"
	>("all");
	const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});

	const { data, isLoading, isError, refetch, dataUpdatedAt } = useQuery({
		queryFn: () => fetchOrgUsage(orgId, monthOffset),
		queryKey: ["v2", "org-usage", orgId, monthOffset],
		// Always refetch when the usage tab mounts. Org admins navigate
		// here specifically to see live seat / hour state across every
		// workspace; React Query's "fresh = skip" optimization made
		// numbers go stale between page visits even after server-side
		// invalidations had landed.
		refetchOnMount: "always",
		refetchOnWindowFocus: "always",
		staleTime: 60_000,
	});

	const handleRefresh = async () => {
		setRefreshing(true);
		try {
			const fresh = await fetchOrgUsage(orgId, monthOffset, true);
			queryClient.setQueryData(["v2", "org-usage", orgId, monthOffset], fresh);
		} catch (err) {
			toast.error(
				err instanceof Error
					? err.message
					: t`Couldn't refresh usage. Try again.`,
			);
		} finally {
			setRefreshing(false);
		}
	};

	const attention = useMemo(
		() => (data ? buildAttention(data.workspaces) : []),
		[data],
	);

	const prefiltered = useMemo(() => {
		const rows = data?.workspaces ?? [];
		return rows.filter((w) => {
			if (tierFilter.length > 0 && !tierFilter.includes(w.tier)) return false;
			if (statusFilter === "active" && !isActive(w)) return false;
			if (statusFilter === "inactive" && isActive(w)) return false;
			return true;
		});
	}, [data, tierFilter, statusFilter]);

	const columns = useMemo<ColumnDef<OrgUsageWorkspaceRow, unknown>[]>(
		() => [
			{
				cell: ({ row }) => (
					<ActionIcon
						size="xs"
						variant="subtle"
						color="gray"
						onClick={() =>
							setExpanded((prev) => ({ ...prev, [row.id]: !prev[row.id] }))
						}
						aria-label={expanded[row.id] ? t`Hide projects` : t`Show projects`}
					>
						{expanded[row.id] ? (
							<IconChevronDown size={12} />
						) : (
							<IconChevronRight size={12} />
						)}
					</ActionIcon>
				),
				enableHiding: false,
				enableSorting: false,
				header: "",
				id: "expander",
			},
			{
				accessorKey: "name",
				cell: ({ row }) => (
					<Group gap={6} wrap="nowrap">
						{(row.original.at_cap || row.original.seat_cap_hit) && (
							<Tooltip
								label={
									row.original.at_cap
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
						{!(row.original.at_cap || row.original.seat_cap_hit) &&
							(row.original.approaching_cap ||
								row.original.approaching_seat_cap) && (
								<Tooltip label={t`Approaching a limit this month`}>
									<IconAlertTriangle
										size={14}
										color="var(--mantine-color-yellow-7)"
									/>
								</Tooltip>
							)}
						{row.original.is_private && (
							<Tooltip label={t`Private workspace`}>
								<IconLock size={12} color="var(--mantine-color-gray-6)" />
							</Tooltip>
						)}
						<UnstyledButton
							onClick={() => navigate(`/w/${row.original.id}/settings/billing`)}
							style={{ cursor: "pointer" }}
						>
							<Text size="sm" truncate>
								{row.original.name}
							</Text>
						</UnstyledButton>
						{row.original.bills_separately && (
							<Tooltip
								label={t`Billed on its own plan, not your organisation's. Manage it from this workspace's billing.`}
							>
								<Badge size="xs" variant="light" color="gray" tt="none">
									<Trans>Billed separately</Trans>
								</Badge>
							</Tooltip>
						)}
					</Group>
				),
				enableHiding: false,
				header: t`Workspace`,
				id: "workspace_name",
			},
			{
				accessorFn: (r) => r.tier,
				cell: ({ row }) => (
					<Badge
						size="xs"
						color={tierColors[row.original.tier] ?? "gray"}
						variant="light"
						tt="capitalize"
					>
						{row.original.tier}
					</Badge>
				),
				header: t`Tier`,
				id: "tier",
				sortingFn: (a, b) =>
					tierRank(a.original.tier) - tierRank(b.original.tier),
			},
			{
				accessorKey: "audio_hours",
				cell: ({ row }) => (
					<UsageBar
						used={row.original.audio_hours}
						cap={row.original.hours_included}
						unit="h"
						block={row.original.at_cap}
					/>
				),
				header: t`Hours`,
				id: "audio_hours",
			},
			{
				accessorKey: "seat_count",
				cell: ({ row }) => (
					<UsageBar
						used={row.original.seat_count}
						cap={row.original.seats_included}
						block={row.original.seat_cap_hit}
					/>
				),
				header: t`Seats`,
				id: "seat_count",
			},
			{
				accessorFn: (r) => (isActive(r) ? "active" : "inactive"),
				cell: ({ row }) =>
					isActive(row.original) ? (
						<Badge size="xs" color="green" variant="light">
							<Trans>Active</Trans>
						</Badge>
					) : (
						<Badge size="xs" color="gray" variant="light">
							<Trans>Inactive</Trans>
						</Badge>
					),
				header: t`Status`,
				id: "is_active",
			},
		],
		[expanded, navigate],
	);

	// Sort the incoming rows by severity once, so the default order is
	// "needs attention first". Sort-by-column overrides this via the
	// table's sorting state.
	const initialSorted = useMemo(() => {
		return [...prefiltered].sort((a, b) => {
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
	}, [prefiltered]);

	const [sorting, setSorting] = useState<SortingState>([]);

	const table = useReactTable<OrgUsageWorkspaceRow>({
		columns,
		data: initialSorted,
		getCoreRowModel: getCoreRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
		getSortedRowModel: getSortedRowModel(),
		onColumnVisibilityChange: (updater) =>
			setColumnVisibility((prev) =>
				typeof updater === "function" ? updater(prev) : updater,
			),
		onGlobalFilterChange: setGlobalFilter,
		onSortingChange: setSorting,
		state: { columnVisibility, globalFilter, sorting },
	});

	const rows = table.getRowModel().rows;
	const leafColumns = table.getVisibleLeafColumns();

	// Totals row uses filtered (post-search) rows so it tracks the
	// user's view. When filter is empty it's the same as the top-level
	// rollup.
	const totalsHours = rows.reduce((s, r) => s + r.original.audio_hours, 0);
	const totalsSeats = rows.reduce((s, r) => s + r.original.seat_count, 0);
	if (isLoading) return null;

	if (isError || !data) {
		return (
			<Paper p="md" radius="md" withBorder>
				<Stack gap="xs">
					<Text size="sm" c="red">
						<Trans>We couldn't load this organisation's usage.</Trans>
					</Text>
					<Group>
						<Button
							size="xs"
							variant="default"
							loading={refreshing}
							onClick={() => refetch()}
						>
							<Trans>Retry</Trans>
						</Button>
					</Group>
				</Stack>
			</Paper>
		);
	}

	const tierOptions = TIER_ORDER.map((x) => ({
		label: x.charAt(0).toUpperCase() + x.slice(1),
		value: x,
	}));
	const visibilityMenuItems = columns
		.filter((c) => c.id && !["expander", "workspace_name"].includes(c.id))
		.map((c) => ({
			id: c.id ?? "",
			label: typeof c.header === "string" ? (c.header as string) : (c.id ?? ""),
		}));

	return (
		<Paper p="md" withBorder radius="sm">
			<Stack gap={12}>
				<Group justify="space-between" wrap="nowrap" gap="xs">
					<Text size="xs" fw={500} tt="uppercase" c="dimmed" lts={0.5}>
						<Trans>Organisation usage</Trans>
					</Text>
					<PeriodSelect value={monthOffset} onChange={setMonthOffset} />
				</Group>

				{attention.length > 0 && (
					<NeedsAttentionPanel
						items={attention}
						onOpen={(id) => navigate(`/w/${id}/settings/billing`)}
					/>
				)}

				<Text size="sm" c="dimmed">
					<Trans>
						{data.workspace_count} workspaces · {data.total_seat_count} paid
						seats · {data.total_observer_count} free observers ·{" "}
						{formatDurationFromHours(data.total_audio_hours)} in{" "}
						{formatCycleMonth(data.cycle_start)}
					</Trans>
				</Text>

				<Group gap="sm" wrap="wrap" align="center">
					<TextInput
						leftSection={<IconSearch size={14} />}
						placeholder={t`Search workspaces`}
						value={globalFilter}
						onChange={(e) => setGlobalFilter(e.currentTarget.value)}
						size="xs"
						style={{ flex: 1, maxWidth: 280, minWidth: 200 }}
					/>
					<MultiSelect
						data={tierOptions}
						value={tierFilter}
						onChange={setTierFilter}
						placeholder={t`All tiers`}
						size="xs"
						clearable
						style={{ minWidth: 160 }}
					/>
					<Button.Group>
						<Button
							size="xs"
							variant={statusFilter === "all" ? "filled" : "default"}
							color={statusFilter === "all" ? "primary" : undefined}
							onClick={() => setStatusFilter("all")}
						>
							<Trans>All</Trans>
						</Button>
						<Button
							size="xs"
							variant={statusFilter === "active" ? "filled" : "default"}
							color={statusFilter === "active" ? "primary" : undefined}
							onClick={() => setStatusFilter("active")}
						>
							<Trans>Active</Trans>
						</Button>
						<Button
							size="xs"
							variant={statusFilter === "inactive" ? "filled" : "default"}
							color={statusFilter === "inactive" ? "primary" : undefined}
							onClick={() => setStatusFilter("inactive")}
						>
							<Trans>Inactive</Trans>
						</Button>
					</Button.Group>
					<Menu shadow="md" width={220} position="bottom-end">
						<Menu.Target>
							<Button
								size="xs"
								variant="default"
								leftSection={<IconAdjustments size={14} />}
							>
								<Trans>Columns</Trans>
							</Button>
						</Menu.Target>
						<Menu.Dropdown>
							<Menu.Label>
								<Trans>Visible columns</Trans>
							</Menu.Label>
							{visibilityMenuItems.map((c) => (
								<Menu.Item
									key={c.id}
									closeMenuOnClick={false}
									onClick={() =>
										setColumnVisibility((v) => ({
											...v,
											[c.id]: v[c.id] === false,
										}))
									}
								>
									<Checkbox
										size="xs"
										label={c.label}
										checked={columnVisibility[c.id] !== false}
										onChange={() =>
											setColumnVisibility((v) => ({
												...v,
												[c.id]: v[c.id] === false,
											}))
										}
										onClick={(e) => e.stopPropagation()}
									/>
								</Menu.Item>
							))}
						</Menu.Dropdown>
					</Menu>
				</Group>

				{rows.length > 0 && (
					<Box style={{ overflowX: "auto" }}>
						<Table verticalSpacing="xs" striped highlightOnHover>
							<Table.Thead>
								{table.getHeaderGroups().map((hg) => (
									<Table.Tr key={hg.id}>
										{hg.headers.map((h) => {
											const canSort = h.column.getCanSort();
											const sorted = h.column.getIsSorted();
											return (
												<Table.Th key={h.id} style={{ padding: 0 }}>
													{canSort ? (
														<UnstyledButton
															onClick={h.column.getToggleSortingHandler()}
															title={t`Click to sort`}
															style={{
																cursor: "pointer",
																display: "block",
																padding: "8px 12px",
																transition: "background 0.1s ease",
																width: "100%",
															}}
															onMouseEnter={(e) => {
																e.currentTarget.style.background =
																	"var(--mantine-color-gray-1)";
															}}
															onMouseLeave={(e) => {
																e.currentTarget.style.background =
																	"transparent";
															}}
														>
															<SortableHeader
																label={
																	typeof h.column.columnDef.header === "string"
																		? (h.column.columnDef.header as string)
																		: ""
																}
																sorted={sorted}
															/>
														</UnstyledButton>
													) : (
														<Box px={12} py={8}>
															<Text
																size="xs"
																fw={500}
																c="dimmed"
																tt="uppercase"
																lts={0.3}
															>
																{flexRender(
																	h.column.columnDef.header,
																	h.getContext(),
																)}
															</Text>
														</Box>
													)}
												</Table.Th>
											);
										})}
									</Table.Tr>
								))}
							</Table.Thead>
							<Table.Tbody>
								{rows.map((row) => (
									<WorkspaceRow
										key={row.id}
										row={row}
										visibleColumnIds={leafColumns.map((c) => c.id)}
										expanded={expanded[row.id] ?? false}
										monthOffset={monthOffset}
									/>
								))}
							</Table.Tbody>
							{rows.length > 0 && (
								<Table.Tfoot>
									<Table.Tr
										style={{
											background: "var(--mantine-color-dark-0, #f1f3f5)",
											borderTop: "2px solid var(--mantine-color-gray-5)",
										}}
									>
										{leafColumns.map((col, i) => {
											const key = col.id;
											// Put "Total" under the first NON-expander visible
											// column. With workspace_name always visible + pinned
											// via enableHiding=false, this lands consistently.
											const isFirstData = i === 1 && key === "workspace_name";
											if (
												key === "expander" ||
												(i === 0 && key !== "workspace_name")
											) {
												return <Table.Td key={col.id} />;
											}
											if (isFirstData) {
												return (
													<Table.Td key={col.id}>
														<Text size="xs" fw={700} tt="uppercase" lts={0.3}>
															<Trans>Total</Trans>
														</Text>
													</Table.Td>
												);
											}
											const footerById: Record<string, React.ReactNode> = {
												audio_hours: (
													<Text size="xs" fw={600}>
														{formatDurationFromHours(totalsHours)}
													</Text>
												),
												seat_count: (
													<Text size="xs" fw={600}>
														{totalsSeats}
													</Text>
												),
											};
											return (
												<Table.Td key={col.id}>
													{footerById[key] ?? null}
												</Table.Td>
											);
										})}
									</Table.Tr>
								</Table.Tfoot>
							)}
						</Table>
					</Box>
				)}

				{rows.length === 0 && (
					<Text size="xs" c="dimmed" ta="center" py="md">
						<Trans>Nothing matches the filter.</Trans>
					</Text>
				)}

				<UsageFreshness
					dataUpdatedAt={dataUpdatedAt}
					refreshing={refreshing}
					onRefresh={handleRefresh}
				/>
			</Stack>
		</Paper>
	);
};

// ── Row renderer with per-project drill-down ──────────────────────────

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

function WorkspaceRow({
	row,
	visibleColumnIds,
	expanded,
	monthOffset,
}: {
	row: {
		id: string;
		original: OrgUsageWorkspaceRow;
		getVisibleCells: () => unknown[];
	};
	visibleColumnIds: string[];
	expanded: boolean;
	monthOffset: number;
}) {
	const { data: wsUsage, isLoading } = useQuery({
		enabled: expanded,
		queryFn: () => fetchWorkspaceUsage(row.original.id, monthOffset),
		queryKey: ["v2", "workspace-usage", row.original.id, monthOffset],
		// Same rationale as the parent rollup: collapse + re-expand should
		// give the user the latest workspace breakdown, not the cached one.
		refetchOnMount: "always",
		refetchOnWindowFocus: "always",
		staleTime: 60_000,
	});
	const projects = wsUsage?.projects ?? [];

	const visibleSet = useMemo(
		() => new Set(visibleColumnIds),
		[visibleColumnIds],
	);
	const allCells = (
		row as unknown as {
			getAllCells: () => Array<{
				id: string;
				column: {
					id: string;
					columnDef: ColumnDef<OrgUsageWorkspaceRow, unknown>;
				};
				getContext: () => unknown;
			}>;
		}
	).getAllCells();
	const cells = allCells.filter((cell) => visibleSet.has(cell.column.id));

	return (
		<>
			<Table.Tr>
				{cells.map((cell) => (
					<Table.Td key={cell.id}>
						{
							flexRender(
								cell.column.columnDef.cell,
								cell.getContext() as never,
							) as React.ReactNode
						}
					</Table.Td>
				))}
			</Table.Tr>
			{expanded && (
				<Table.Tr>
					<Table.Td />
					<Table.Td colSpan={visibleColumnIds.length - 1}>
						{isLoading ? (
							<Text size="xs" c="dimmed" py={4}>
								<Trans>Loading projects...</Trans>
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
										<Text size="xs" style={{ minWidth: 60 }}>
											{formatDurationFromHours(p.audio_hours)}
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

// ── Needs attention + Overage panels ──────────────────────────────────

interface AttentionItem {
	id: string;
	key: string;
	reason:
		| "seats_full"
		| "seats_near"
		| "hours_full"
		| "hours_near"
		| "recently_downgraded";
	message: string;
	actionLabel: string;
	workspaceId: string;
}

// Free + pilot gate consumption. Gated tiers go in "Needs attention".
function isHardBlockTier(tier: string): boolean {
	return tier === "free" || tier === "pilot";
}

function formatSeatFraction(
	seat_count: number,
	seats_included: number | null,
): string {
	return `${seat_count}/${seats_included ?? "∞"}`;
}

function formatHourFraction(hours: number, cap: number | null): string {
	return cap != null ? `${hours.toFixed(1)}/${cap}h` : `${hours.toFixed(1)}h`;
}

// Items that genuinely need admin action: hard-block tiers at cap,
// approaching-cap on hard-block tiers, recently-downgraded workspaces.
function buildAttention(workspaces: OrgUsageWorkspaceRow[]): AttentionItem[] {
	const out: AttentionItem[] = [];
	// Only used by the disabled "recently downgraded" check below.
	// const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000;
	// const now = Date.now();

	for (const ws of workspaces) {
		// Separately-billed workspaces run on their own plan; the org admin can't
		// act on their caps from here, so they don't belong in the org's panel.
		if (ws.bills_separately) continue;

		const hardBlock = isHardBlockTier(ws.tier);

		if (ws.seat_cap_hit && hardBlock) {
			out.push({
				actionLabel: "Upgrade",
				id: ws.id,
				key: `${ws.id}:seats_full`,
				message: `${ws.name} has reached its seats. Upgrade to Changemaker for unlimited transcription and to invite your team.`,
				reason: "seats_full",
				workspaceId: ws.id,
			});
		} else if (ws.approaching_seat_cap && hardBlock) {
			// Approaching cap is only actionable on hard-block tiers; on
			// Pioneer+ "near included" doesn't trigger anything bad so it
			// shouldn't read as a warning.
			out.push({
				actionLabel: "Review",
				id: ws.id,
				key: `${ws.id}:seats_near`,
				message: `${ws.name} near seat cap (${formatSeatFraction(ws.seat_count, ws.seats_included)}) on ${ws.tier}`,
				reason: "seats_near",
				workspaceId: ws.id,
			});
		}

		// at_cap on hours is only set server-side when the tier
		// hard-blocks hours (Pilot per matrix §8). It's always actionable.
		if (ws.at_cap) {
			out.push({
				actionLabel: "Upgrade",
				id: ws.id,
				key: `${ws.id}:hours_full`,
				message: `${ws.name} at ${ws.tier} hour limit (${formatHourFraction(ws.audio_hours, ws.hours_included)}). Host-side tools paused.`,
				reason: "hours_full",
				workspaceId: ws.id,
			});
		} else if (ws.approaching_cap && hardBlock) {
			out.push({
				actionLabel: "Review",
				id: ws.id,
				key: `${ws.id}:hours_near`,
				message: `${ws.name} near ${ws.tier} hour limit (${formatHourFraction(ws.audio_hours, ws.hours_included)})`,
				reason: "hours_near",
				workspaceId: ws.id,
			});
		}

		// Downgrade tracking moved to the billing account / reworked with new
		// pricing; "recently downgraded" attention disabled for now.
		// if (ws.downgraded_at) {
		// 	const dtMs = new Date(ws.downgraded_at).getTime();
		// 	if (!Number.isNaN(dtMs) && now - dtMs < SEVEN_DAYS_MS) {
		// 		out.push({
		// 			actionLabel: "Review",
		// 			id: ws.id,
		// 			key: `${ws.id}:recently_downgraded`,
		// 			message: `${ws.name} was downgraded recently, verify limits`,
		// 			reason: "recently_downgraded",
		// 			workspaceId: ws.id,
		// 		});
		// 	}
		// }
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
					<IconAlertTriangle size={14} color="var(--mantine-color-yellow-7)" />
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
							align="flex-start"
						>
							<Text size="sm" style={{ flex: 1 }}>
								{item.message}
							</Text>
							<Button
								size="xs"
								flex="0 0 auto"
								onClick={() => onOpen(item.workspaceId)}
							>
								{item.actionLabel}
							</Button>
						</Group>
					))}
				</Stack>
				{hidden > 0 && !showAll && (
					<UnstyledButton onClick={() => setShowAll(true)}>
						<Text size="xs" c="primary">
							<Trans>Show {hidden} more</Trans>
						</Text>
					</UnstyledButton>
				)}
			</Stack>
		</Paper>
	);
}
