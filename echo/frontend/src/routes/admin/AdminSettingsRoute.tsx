import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Anchor,
	Badge,
	Box,
	Button,
	Center,
	Checkbox,
	Collapse,
	Container,
	Divider,
	Group,
	Loader,
	Menu,
	Modal,
	MultiSelect,
	Paper,
	Progress,
	SimpleGrid,
	Stack,
	Table,
	Tabs,
	Text,
	TextInput,
	Title,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { useDisclosure, useDocumentTitle } from "@mantine/hooks";
import {
	IconAdjustments,
	IconChevronDown,
	IconChevronRight,
	IconDots,
	IconDownload,
	IconSearch,
	IconSortAscending,
	IconSortDescending,
	IconUsersGroup,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import {
	type ColumnDef,
	type ColumnFiltersState,
	type GroupingState,
	type Row,
	type SortingState,
	type VisibilityState,
	flexRender,
	getCoreRowModel,
	getExpandedRowModel,
	getFilteredRowModel,
	getGroupedRowModel,
	getSortedRowModel,
	useReactTable,
} from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { I18nLink } from "@/components/common/i18nLink";
import { TierCapacityMatrix } from "@/components/workspace/TierCapacityMatrix";
import { API_BASE_URL } from "@/config";
import { useV2Me } from "@/hooks/useV2Me";

// Ordered tier list for custom sorting. matrix v1.1 §1 order from low to high.
const TIER_ORDER = ["pilot", "pioneer", "innovator", "changemaker", "guardian"] as const;
type Tier = (typeof TIER_ORDER)[number];
const tierRank = (tier: string): number => TIER_ORDER.indexOf(tier as Tier);

const tierColors: Record<string, string> = {
	pilot: "gray",
	pioneer: "blue",
	innovator: "violet",
	changemaker: "grape",
	guardian: "orange",
};

type BillingContact = {
	user_id: string | null;
	display_name: string | null;
	email: string | null;
};

type BillingRow = {
	workspace_id: string;
	workspace_name: string;
	org_id: string;
	org_name: string;
	tier: string;
	is_partner_owned: boolean;
	billed_to_team_id: string | null;
	billed_to_team_name: string | null;
	audio_hours: number;
	audio_hours_included: number | null;
	hours_pct: number | null;
	over_hours: number;
	hour_overage_eur: number;
	seat_count: number;
	seats_included: number | null;
	over_seats: number;
	seat_overage_eur: number;
	base_price_eur: number | null;
	total_forecast_eur: number | null;
	pilot_hard_block: boolean;
	approaching_cap: boolean;
	at_cap: boolean;
	downgraded_at: string | null;
	downgraded_from_tier: string | null;
	is_active: boolean;
	workspace_admins: BillingContact[];
};

type BillingRollup = {
	cycle_start: string;
	cycle_end_exclusive: string;
	workspace_count: number;
	active_workspace_count: number;
	total_base_eur: number;
	total_overage_eur: number;
	total_forecast_eur: number;
	mrr_eur: number;
	logins_last_30d: number;
	rows: BillingRow[];
};

type ReferralLedgerRow = {
	id: string;
	workspace_id: string | null;
	workspace_name: string | null;
	partner_team_id: string | null;
	partner_team_name: string | null;
	from_org_id: string | null;
	from_org_name: string | null;
	partner_kickback_percent: number | null;
	to_team_discount_percent: number | null;
	eur_cap_kickback: number | null;
	starts_at: string | null;
	expires_at: string | null;
	notes: string | null;
};

type UpgradeRequestRow = {
	id: string;
	workspace_id: string;
	workspace_name: string;
	org_id: string;
	org_name: string;
	current_tier: string;
	target_tier: string;
	audio_hours_current: number;
	audio_hours_included: number | null;
	seat_count: number;
	seats_included: number | null;
	requested_at: string;
	requested_by: string | null;
};

async function fetchJson<T>(path: string): Promise<T | null> {
	const res = await fetch(`${API_BASE_URL}${path}`, { credentials: "include" });
	if (!res.ok) return null;
	return res.json();
}

const formatEur = (n: number | null | undefined): string => {
	if (n == null) return "";
	if (n === 0) return "€0";
	return `€${Math.round(n).toLocaleString()}`;
};

const formatDate = (iso: string | null | undefined): string => {
	if (!iso) return "";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
		year: "numeric",
	});
};

/**
 * Period selector. Current month, previous month, 2 months back, 3
 * months back. Negative offsets only (no future). Matches the staff
 * mental model of "this month's invoice run" and "oh wait, what did
 * we bill last month again?".
 */
function PeriodSelector({
	value,
	onChange,
}: {
	value: number;
	onChange: (offset: number) => void;
}) {
	const options: { offset: number; label: string }[] = [
		{ offset: 0, label: t`This month` },
		{ offset: -1, label: t`Last month` },
		{ offset: -2, label: t`2 months ago` },
		{ offset: -3, label: t`3 months ago` },
	];
	return (
		<Button.Group>
			{options.map((opt) => (
				<Button
					key={opt.offset}
					size="xs"
					variant={value === opt.offset ? "filled" : "default"}
					color={value === opt.offset ? "blue" : "gray"}
					onClick={() => onChange(opt.offset)}
				>
					{opt.label}
				</Button>
			))}
		</Button.Group>
	);
}

function SortableHeader({
	label,
	sorted,
	align = "left",
}: {
	label: string;
	sorted: false | "asc" | "desc";
	align?: "left" | "right";
}) {
	return (
		<Group
			gap={4}
			wrap="nowrap"
			justify={align === "right" ? "flex-end" : "flex-start"}
		>
			<Text size="xs" fw={500} c="dimmed" tt="uppercase" lts={0.3}>
				{label}
			</Text>
			{sorted === "asc" && (
				<IconSortAscending size={12} color="var(--mantine-color-gray-6)" />
			)}
			{sorted === "desc" && (
				<IconSortDescending size={12} color="var(--mantine-color-gray-6)" />
			)}
		</Group>
	);
}

/**
 * Inline usage bar. Green under 60 percent, yellow 60 to 90, red over
 * 90. Shows N / cap next to the bar. When cap is null (guardian, pilot
 * with no ceiling) we render the raw count with a dash.
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

/**
 * Mocked actions modal. The buttons are disabled on purpose; they
 * communicate the action shape staff will eventually have without
 * letting anyone run them. Copy reads natural (no "coming soon"
 * language); only the disabled state signals state.
 */
function WorkspaceActionsModal({
	row,
	opened,
	onClose,
}: {
	row: BillingRow | null;
	opened: boolean;
	onClose: () => void;
}) {
	if (!row) return null;
	const actions: { label: string; hint: string; color?: string }[] = [
		{
			label: t`Change tier`,
			hint: t`Pick a new tier and apply downgrade effects per matrix.`,
		},
		{
			label: t`Change workspace admin`,
			hint: t`Transfer the primary admin role to another member.`,
		},
		{
			label: t`Reset monthly usage`,
			hint: t`Back out this cycle's hour count after a support incident.`,
		},
		{
			label: t`Transfer workspace to another team`,
			hint: t`Partner handoff. Writes billed_to_team_id and notifies both teams.`,
		},
		{
			label: t`Delete workspace`,
			hint: t`Soft-delete. Data stays recoverable for 30 days.`,
			color: "red",
		},
	];
	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={
				<Group gap="xs">
					<Text fw={500}>{row.workspace_name}</Text>
					<Badge
						size="xs"
						color={tierColors[row.tier] ?? "gray"}
						variant="light"
						tt="capitalize"
					>
						{row.tier}
					</Badge>
				</Group>
			}
			size="md"
		>
			<Stack gap="xs">
				<Text size="xs" c="dimmed">
					<Trans>
						{row.org_name}, workspace id {row.workspace_id.slice(0, 8)}
					</Trans>
				</Text>
				<Divider my={4} />
				{actions.map((a) => (
					<Paper key={a.label} withBorder radius="sm" p="sm">
						<Group justify="space-between" wrap="nowrap" align="center">
							<Stack gap={0} style={{ minWidth: 0 }}>
								<Text size="sm" fw={500}>
									{a.label}
								</Text>
								<Text size="xs" c="dimmed">
									{a.hint}
								</Text>
							</Stack>
							<Button
								size="xs"
								variant="default"
								color={a.color ?? "gray"}
								disabled
							>
								<Trans>Run</Trans>
							</Button>
						</Group>
					</Paper>
				))}
			</Stack>
		</Modal>
	);
}

/**
 * TanStack Table wrapper with extra features: column visibility menu,
 * grouping, footer totals row, per-column sort. The Billing panel
 * drives all of its state from outside so it can wire filter chips,
 * KPI rollups, and the actions modal.
 */
function BillingTable({
	columns,
	data,
	globalFilter,
	onGlobalFilterChange,
	columnFilters,
	onColumnFiltersChange,
	columnVisibility,
	onColumnVisibilityChange,
	grouping,
	onGroupingChange,
	initialSorting,
	footerTotals,
}: {
	columns: ColumnDef<BillingRow, unknown>[];
	data: BillingRow[];
	globalFilter: string;
	onGlobalFilterChange: (v: string) => void;
	columnFilters: ColumnFiltersState;
	onColumnFiltersChange: (v: ColumnFiltersState) => void;
	columnVisibility: VisibilityState;
	onColumnVisibilityChange: (v: VisibilityState) => void;
	grouping: GroupingState;
	onGroupingChange: (v: GroupingState) => void;
	initialSorting?: SortingState;
	footerTotals: {
		audio_hours: number;
		seat_count: number;
		base_price_eur: number;
		hour_overage_eur: number;
		seat_overage_eur: number;
		total_forecast_eur: number;
	};
}) {
	const [sorting, setSorting] = useState<SortingState>(initialSorting ?? []);
	// TanStack's ExpandedState is Record<string, boolean> | true, but the
	// 'true' shorthand isn't useful to us — we always track per-row
	// expansion. Hold local state and let the table pass full updates.
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});

	const table = useReactTable<BillingRow>({
		columns,
		data,
		state: {
			sorting,
			globalFilter,
			columnFilters,
			columnVisibility,
			grouping,
			expanded,
		},
		onSortingChange: setSorting,
		onGlobalFilterChange,
		onColumnFiltersChange: (updater) =>
			onColumnFiltersChange(
				typeof updater === "function" ? updater(columnFilters) : updater,
			),
		onColumnVisibilityChange: (updater) =>
			onColumnVisibilityChange(
				typeof updater === "function" ? updater(columnVisibility) : updater,
			),
		onGroupingChange: (updater) =>
			onGroupingChange(
				typeof updater === "function" ? updater(grouping) : updater,
			),
		onExpandedChange: (updater) => {
			const next =
				typeof updater === "function" ? updater(expanded) : updater;
			// Reject the 'true' shorthand; we never set that state.
			if (next === true) return;
			setExpanded(next as Record<string, boolean>);
		},
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
		getGroupedRowModel: getGroupedRowModel(),
		getExpandedRowModel: getExpandedRowModel(),
		// 'reorder' (default) moves grouped columns to the front so team
		// renders first when group-by-team is active; being explicit here
		// makes that contract impossible to miss during future edits.
		groupedColumnMode: "reorder",
		autoResetExpanded: false,
	});

	const rows = table.getRowModel().rows;
	const leafColumns = table.getVisibleLeafColumns();

	return (
		<Paper withBorder radius="sm" style={{ overflowX: "auto" }}>
			<Table striped highlightOnHover verticalSpacing="xs" fz="xs">
				<Table.Thead>
					{table.getHeaderGroups().map((headerGroup) => (
						<Table.Tr key={headerGroup.id}>
							{headerGroup.headers.map((header) => {
								const canSort = header.column.getCanSort();
								const sorted = header.column.getIsSorted();
								const align =
									(
										header.column.columnDef.meta as
											| { align?: "left" | "right" }
											| undefined
									)?.align ?? "left";
								return (
									<Table.Th key={header.id} ta={align}>
										{canSort ? (
											<UnstyledButton
												onClick={header.column.getToggleSortingHandler()}
												style={{ width: "100%" }}
											>
												<SortableHeader
													label={
														typeof header.column.columnDef.header === "string"
															? (header.column.columnDef.header as string)
															: ""
													}
													sorted={sorted}
													align={align}
												/>
											</UnstyledButton>
										) : (
											<Text
												size="xs"
												fw={500}
												c="dimmed"
												tt="uppercase"
												lts={0.3}
											>
												{flexRender(
													header.column.columnDef.header,
													header.getContext(),
												)}
											</Text>
										)}
									</Table.Th>
								);
							})}
						</Table.Tr>
					))}
				</Table.Thead>
				<Table.Tbody>
					{rows.length === 0 ? (
						<Table.Tr>
							<Table.Td colSpan={leafColumns.length}>
								<Text size="xs" c="dimmed" ta="center" py="md">
									<Trans>Nothing matches the filter.</Trans>
								</Text>
							</Table.Td>
						</Table.Tr>
					) : (
						rows.map((row) => {
							// Grouping renders header rows with a single merged cell.
							if (row.getIsGrouped()) {
								const groupValue = String(row.getValue(row.groupingColumnId ?? ""));
								const descendants = row.getLeafRows();
								const teamBase = descendants.reduce(
									(s, r) => s + (r.original.base_price_eur ?? 0),
									0,
								);
								const teamOverage = descendants.reduce(
									(s, r) =>
										s + r.original.hour_overage_eur + r.original.seat_overage_eur,
									0,
								);
								const teamTotal = descendants.reduce(
									(s, r) => s + (r.original.total_forecast_eur ?? 0),
									0,
								);
								return (
									<Table.Tr
										key={row.id}
										style={{ background: "var(--mantine-color-gray-0)" }}
									>
										<Table.Td colSpan={leafColumns.length}>
											<UnstyledButton
												onClick={row.getToggleExpandedHandler()}
												style={{ width: "100%" }}
											>
												<Group justify="space-between" wrap="nowrap">
													<Group gap="xs">
														{row.getIsExpanded() ? (
															<IconChevronDown size={14} />
														) : (
															<IconChevronRight size={14} />
														)}
														<Text size="sm" fw={500}>
															{groupValue || t`Unassigned team`}
														</Text>
														<Text size="xs" c="dimmed">
															{descendants.length}{" "}
															{descendants.length === 1
																? t`workspace`
																: t`workspaces`}
														</Text>
													</Group>
													<Group gap="md">
														<Text size="xs" c="dimmed">
															<Trans>Base</Trans> {formatEur(teamBase)}
														</Text>
														<Text size="xs" c="dimmed">
															<Trans>Overage</Trans> {formatEur(teamOverage)}
														</Text>
														<Text size="xs" fw={500}>
															<Trans>Total</Trans> {formatEur(teamTotal)}
														</Text>
													</Group>
												</Group>
											</UnstyledButton>
										</Table.Td>
									</Table.Tr>
								);
							}
							return (
								<Table.Tr key={row.id}>
									{row.getVisibleCells().map((cell) => {
										const align =
											(
												cell.column.columnDef.meta as
													| { align?: "left" | "right" }
													| undefined
											)?.align ?? "left";
										return (
											<Table.Td key={cell.id} ta={align}>
												{flexRender(cell.column.columnDef.cell, cell.getContext())}
											</Table.Td>
										);
									})}
								</Table.Tr>
							);
						})
					)}
				</Table.Tbody>
				{rows.length > 0 && (
					<Table.Tfoot>
						<Table.Tr
							style={{
								// Visibly distinct: graphite-tinted row, thicker
								// top border, bold text. Reads as a summary bar
								// not "another data row".
								background: "var(--mantine-color-dark-0, #f1f3f5)",
								borderTop: "2px solid var(--mantine-color-gray-5)",
							}}
						>
							{leafColumns.map((col, i) => {
								const key = col.id;
								// Render "Total" label under the first visible
								// column (works with / without grouping which
								// moves team to leaf[0]).
								if (i === 0) {
									return (
										<Table.Td key={col.id}>
											<Text size="xs" fw={700} tt="uppercase" lts={0.3}>
												<Trans>Total</Trans>
											</Text>
										</Table.Td>
									);
								}
								// Lookup table keyed by column id — immune to
								// column-visibility or reorder churn.
								const footerById: Record<string, React.ReactNode> = {
									audio_hours: (
										<Text size="xs" fw={600} ta="right">
											{footerTotals.audio_hours.toFixed(1)} h
										</Text>
									),
									seat_count: (
										<Text size="xs" fw={600} ta="right">
											{footerTotals.seat_count}
										</Text>
									),
									base_price_eur: (
										<Text size="xs" fw={600} ta="right">
											{formatEur(footerTotals.base_price_eur)}
										</Text>
									),
									hour_overage_eur: (
										<Text
											size="xs"
											fw={600}
											ta="right"
											c={
												footerTotals.hour_overage_eur > 0
													? "orange"
													: undefined
											}
										>
											{formatEur(footerTotals.hour_overage_eur)}
										</Text>
									),
									seat_overage_eur: (
										<Text
											size="xs"
											fw={600}
											ta="right"
											c={
												footerTotals.seat_overage_eur > 0
													? "orange"
													: undefined
											}
										>
											{formatEur(footerTotals.seat_overage_eur)}
										</Text>
									),
									total_forecast_eur: (
										<Text size="xs" fw={700} ta="right">
											{formatEur(footerTotals.total_forecast_eur)}
										</Text>
									),
								};
								return (
									<Table.Td key={col.id}>{footerById[key] ?? null}</Table.Td>
								);
							})}
						</Table.Tr>
					</Table.Tfoot>
				)}
			</Table>
		</Paper>
	);
}

function TierBreakdownPanel({ rows }: { rows: BillingRow[] }) {
	const [opened, { toggle }] = useDisclosure(true);

	const byTier = useMemo(() => {
		const groups = new Map<
			string,
			{ count: number; base: number; overage: number; active: number }
		>();
		for (const tier of TIER_ORDER) {
			groups.set(tier, { count: 0, base: 0, overage: 0, active: 0 });
		}
		for (const r of rows) {
			const g = groups.get(r.tier) ?? { count: 0, base: 0, overage: 0, active: 0 };
			g.count += 1;
			g.base += r.base_price_eur ?? 0;
			g.overage += r.hour_overage_eur + r.seat_overage_eur;
			if (r.is_active) g.active += 1;
			groups.set(r.tier, g);
		}
		return TIER_ORDER.map((tier) => ({
			tier,
			...(groups.get(tier) ?? { count: 0, base: 0, overage: 0, active: 0 }),
		}));
	}, [rows]);

	return (
		<Paper withBorder radius="sm" p="sm">
			<UnstyledButton onClick={toggle} style={{ width: "100%" }}>
				<Group justify="space-between" wrap="nowrap">
					<Group gap="xs">
						{opened ? (
							<IconChevronDown size={14} />
						) : (
							<IconChevronRight size={14} />
						)}
						<Text size="sm" fw={500}>
							<Trans>Breakdown by tier</Trans>
						</Text>
					</Group>
					<Text size="xs" c="dimmed">
						<Plural value={rows.length} one="# workspace" other="# workspaces" />
					</Text>
				</Group>
			</UnstyledButton>
			<Collapse in={opened}>
				<Box mt="sm">
					<SimpleGrid cols={{ base: 2, sm: 3, md: 5 }} spacing="sm">
						{byTier.map((b) => (
							<Paper key={b.tier} withBorder radius="sm" p="sm">
								<Stack gap={2}>
									<Badge
										size="xs"
										color={tierColors[b.tier] ?? "gray"}
										variant="light"
										tt="capitalize"
									>
										{b.tier}
									</Badge>
									<Text size="lg" fw={500}>
										{b.count}
									</Text>
									<Text size="xs" c="dimmed">
										<Trans>{b.active} active</Trans>
									</Text>
									<Group gap={4}>
										<Text size="xs" c="dimmed">
											<Trans>Base</Trans>
										</Text>
										<Text size="xs">{formatEur(b.base)}</Text>
									</Group>
									<Group gap={4}>
										<Text size="xs" c="dimmed">
											<Trans>Overage</Trans>
										</Text>
										<Text size="xs">{formatEur(b.overage)}</Text>
									</Group>
								</Stack>
							</Paper>
						))}
					</SimpleGrid>
				</Box>
			</Collapse>
		</Paper>
	);
}

function UsageAndBillingPanel() {
	const [periodOffset, setPeriodOffset] = useState(0);
	const { data, isLoading } = useQuery({
		queryKey: ["v2", "admin", "billing-rollup", periodOffset],
		queryFn: () =>
			fetchJson<BillingRollup>(
				`/v2/admin/billing-rollup?month_offset=${periodOffset}`,
			),
		staleTime: 60_000,
	});

	const [globalFilter, setGlobalFilter] = useState("");
	const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
	const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
	const [grouping, setGrouping] = useState<GroupingState>([]);
	const [onlyOver, setOnlyOver] = useState(false);
	const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">(
		"all",
	);
	const [tierFilter, setTierFilter] = useState<string[]>([]);
	const [actionsRow, setActionsRow] = useState<BillingRow | null>(null);

	// Pre-filter handles the fast chip-toggles; column filters inside
	// TanStack handle per-column multiselects (currently tier).
	const prefiltered = useMemo(() => {
		const rows = data?.rows ?? [];
		return rows.filter((r) => {
			if (onlyOver && r.hour_overage_eur === 0 && r.seat_overage_eur === 0)
				return false;
			if (statusFilter === "active" && !r.is_active) return false;
			if (statusFilter === "inactive" && r.is_active) return false;
			if (tierFilter.length > 0 && !tierFilter.includes(r.tier)) return false;
			return true;
		});
	}, [data, onlyOver, statusFilter, tierFilter]);

	const columns = useMemo<ColumnDef<BillingRow, unknown>[]>(
		() => [
			{
				id: "workspace_name",
				accessorKey: "workspace_name",
				header: t`Workspace`,
				// Workspace name anchors the whole row — if the user hides
				// it, the total row + every other column becomes unreadable.
				// The menu already filters it out; this belts-and-braces
				// prevents it via a stray columnVisibility write too.
				enableHiding: false,
				cell: ({ row }) => {
					const admins = row.original.workspace_admins;
					const adminEmail = admins[0]?.email ?? null;
					return (
						<Stack gap={0} style={{ minWidth: 0 }}>
							<Anchor
								component={I18nLink}
								to={`/w/${row.original.workspace_id}/settings/billing`}
								size="xs"
								fw={500}
							>
								{row.original.workspace_name}
							</Anchor>
							{adminEmail && (
								<Tooltip
									label={admins
										.map((a) => `${a.display_name ?? "?"} ${a.email ?? ""}`)
										.join(" / ")}
									withArrow
									disabled={admins.length <= 1}
								>
									<Text size="xs" c="dimmed" truncate maw={220}>
										{adminEmail}
									</Text>
								</Tooltip>
							)}
						</Stack>
					);
				},
			},
			{
				id: "team",
				accessorFn: (r) => r.billed_to_team_name ?? r.org_name,
				header: t`Team`,
				// Used for grouping; the grouped-row renderer in BillingTable
				// reads this to label the header.
				getGroupingValue: (r) => r.billed_to_team_name ?? r.org_name,
				cell: ({ row }) => (
					<Group gap={4} wrap="nowrap">
						<Anchor
							component={I18nLink}
							to={`/t/${row.original.org_id}`}
							size="xs"
							c="dimmed"
						>
							{row.original.billed_to_team_name ?? row.original.org_name}
						</Anchor>
						{row.original.is_partner_owned && (
							<Badge size="xs" color="violet" variant="light">
								<Trans>partner</Trans>
							</Badge>
						)}
					</Group>
				),
			},
			{
				id: "tier",
				accessorFn: (r) => r.tier,
				sortingFn: (a, b) =>
					tierRank(a.original.tier) - tierRank(b.original.tier),
				header: t`Tier`,
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
			},
			{
				id: "base_price_eur",
				accessorKey: "base_price_eur",
				header: t`Base`,
				meta: { align: "right" },
				cell: ({ row }) => formatEur(row.original.base_price_eur),
			},
			{
				id: "audio_hours",
				accessorKey: "audio_hours",
				header: t`Hours`,
				meta: { align: "right" },
				cell: ({ row }) => (
					<UsageBar
						used={row.original.audio_hours}
						cap={row.original.audio_hours_included}
						unit="h"
						block={row.original.pilot_hard_block}
					/>
				),
			},
			{
				id: "hour_overage_eur",
				accessorKey: "hour_overage_eur",
				header: t`Overage hrs`,
				meta: { align: "right" },
				cell: ({ row }) => {
					const v = row.original.hour_overage_eur;
					const over = row.original.over_hours;
					const hasOverage = v > 0 || over > 0;
					return (
						<Stack gap={0} align="flex-end">
							<Text
								size="xs"
								c={hasOverage ? "orange" : "dimmed"}
								fw={hasOverage ? 500 : 400}
							>
								{formatEur(v)}
							</Text>
							<Text size="xs" c="dimmed">
								{over.toFixed(1)} h over
							</Text>
						</Stack>
					);
				},
			},
			{
				id: "seat_count",
				accessorKey: "seat_count",
				header: t`Seats`,
				meta: { align: "right" },
				cell: ({ row }) => (
					<UsageBar
						used={row.original.seat_count}
						cap={row.original.seats_included}
					/>
				),
			},
			{
				id: "seat_overage_eur",
				accessorKey: "seat_overage_eur",
				header: t`Overage seats`,
				meta: { align: "right" },
				cell: ({ row }) => {
					const v = row.original.seat_overage_eur;
					const over = row.original.over_seats;
					const hasOverage = v > 0 || over > 0;
					return (
						<Stack gap={0} align="flex-end">
							<Text
								size="xs"
								c={hasOverage ? "orange" : "dimmed"}
								fw={hasOverage ? 500 : 400}
							>
								{formatEur(v)}
							</Text>
							<Text size="xs" c="dimmed">
								{over} over
							</Text>
						</Stack>
					);
				},
			},
			{
				id: "is_active",
				accessorFn: (r) => (r.is_active ? "active" : "inactive"),
				header: t`Status`,
				cell: ({ row }) =>
					row.original.is_active ? (
						<Badge size="xs" color="green" variant="light">
							<Trans>Active</Trans>
						</Badge>
					) : (
						<Badge size="xs" color="gray" variant="light">
							<Trans>Inactive</Trans>
						</Badge>
					),
			},
			{
				id: "total_forecast_eur",
				accessorKey: "total_forecast_eur",
				header: t`Total`,
				meta: { align: "right" },
				cell: ({ row }) => (
					<Text size="xs" fw={500}>
						{formatEur(row.original.total_forecast_eur)}
					</Text>
				),
			},
			{
				id: "actions",
				header: "",
				enableSorting: false,
				enableGrouping: false,
				enableHiding: false,
				cell: ({ row }) => (
					<ActionIcon
						size="sm"
						variant="subtle"
						color="gray"
						onClick={() => setActionsRow(row.original)}
						aria-label={t`Open actions`}
					>
						<IconDots size={14} />
					</ActionIcon>
				),
			},
		],
		[],
	);

	const footerTotals = useMemo(
		() => ({
			audio_hours: prefiltered.reduce((s, r) => s + r.audio_hours, 0),
			seat_count: prefiltered.reduce((s, r) => s + r.seat_count, 0),
			base_price_eur: prefiltered.reduce(
				(s, r) => s + (r.base_price_eur ?? 0),
				0,
			),
			hour_overage_eur: prefiltered.reduce(
				(s, r) => s + r.hour_overage_eur,
				0,
			),
			seat_overage_eur: prefiltered.reduce(
				(s, r) => s + r.seat_overage_eur,
				0,
			),
			total_forecast_eur: prefiltered.reduce(
				(s, r) => s + (r.total_forecast_eur ?? 0),
				0,
			),
		}),
		[prefiltered],
	);

	if (isLoading) {
		return (
			<Center py="xl">
				<Loader size="sm" color="gray" />
			</Center>
		);
	}
	if (!data) {
		return (
			<Text c="red" size="sm">
				<Trans>Could not load the rollup. Check auth and backend logs.</Trans>
			</Text>
		);
	}

	const cycleLabel = new Date(data.cycle_start).toLocaleDateString(undefined, {
		month: "long",
		year: "numeric",
	});

	const handleExport = () => {
		const headers = [
			"workspace_id",
			"workspace_name",
			"team",
			"tier",
			"audio_hours",
			"audio_hours_included",
			"hour_overage_eur",
			"seat_count",
			"seats_included",
			"seat_overage_eur",
			"base_price_eur",
			"total_forecast_eur",
			"workspace_admin_email",
			"is_active",
		];
		const lines = prefiltered.map((r) =>
			[
				r.workspace_id,
				r.workspace_name,
				r.billed_to_team_name ?? r.org_name,
				r.tier,
				r.audio_hours.toFixed(2),
				r.audio_hours_included ?? "",
				r.hour_overage_eur.toFixed(2),
				r.seat_count,
				r.seats_included ?? "",
				r.seat_overage_eur.toFixed(2),
				r.base_price_eur ?? "",
				r.total_forecast_eur ?? "",
				r.workspace_admins[0]?.email ?? "",
				r.is_active ? "yes" : "no",
			]
				.map((v) => `"${String(v).replace(/"/g, '""')}"`)
				.join(","),
		);
		const csv = [headers.join(","), ...lines].join("\n");
		const blob = new Blob([csv], { type: "text/csv" });
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = url;
		link.download = `usage-and-billing-${data.cycle_start.slice(0, 7)}.csv`;
		link.click();
		URL.revokeObjectURL(url);
	};

	const tierOptions = TIER_ORDER.map((t) => ({
		value: t,
		label: t.charAt(0).toUpperCase() + t.slice(1),
	}));

	// Column visibility menu: let staff hide noisy columns.
	const columnMenuItems = columns
		.filter((c) => c.id && c.id !== "actions" && c.id !== "workspace_name")
		.map((c) => ({
			id: c.id ?? "",
			label: typeof c.header === "string" ? (c.header as string) : (c.id ?? ""),
		}));

	const isGrouped = grouping.includes("team");

	return (
		<Stack gap="md">
			<Group justify="space-between" align="flex-end" wrap="wrap">
				<Stack gap={2}>
					<Text size="sm" c="dimmed">
						<Trans>Usage and billing, {cycleLabel}</Trans>
					</Text>
					<Text size="xs" c="dimmed">
						<Trans>
							{data.workspace_count} workspaces, {data.active_workspace_count}{" "}
							active
						</Trans>
					</Text>
				</Stack>
				<PeriodSelector value={periodOffset} onChange={setPeriodOffset} />
			</Group>

			<Group gap="sm" wrap="wrap" align="center">
				<TextInput
					leftSection={<IconSearch size={14} />}
					placeholder={t`Search workspace, team, email, tier`}
					value={globalFilter}
					onChange={(e) => setGlobalFilter(e.currentTarget.value)}
					size="sm"
					style={{ flex: 1, minWidth: 220, maxWidth: 360 }}
				/>
				<MultiSelect
					data={tierOptions}
					value={tierFilter}
					onChange={setTierFilter}
					placeholder={t`All tiers`}
					size="xs"
					clearable
					style={{ minWidth: 180 }}
				/>
				<Button.Group>
					<Button
						size="xs"
						variant={statusFilter === "all" ? "filled" : "default"}
						color={statusFilter === "all" ? "blue" : "gray"}
						onClick={() => setStatusFilter("all")}
					>
						<Trans>All</Trans>
					</Button>
					<Button
						size="xs"
						variant={statusFilter === "active" ? "filled" : "default"}
						color={statusFilter === "active" ? "green" : "gray"}
						onClick={() => setStatusFilter("active")}
					>
						<Trans>Active</Trans>
					</Button>
					<Button
						size="xs"
						variant={statusFilter === "inactive" ? "filled" : "default"}
						color="gray"
						onClick={() => setStatusFilter("inactive")}
					>
						<Trans>Inactive</Trans>
					</Button>
				</Button.Group>
				<Button
					size="xs"
					variant={onlyOver ? "filled" : "default"}
					color={onlyOver ? "red" : "gray"}
					onClick={() => setOnlyOver((v) => !v)}
				>
					<Trans>Over cap only</Trans>
				</Button>
				<Button
					size="xs"
					variant={isGrouped ? "filled" : "default"}
					color={isGrouped ? "blue" : "gray"}
					leftSection={<IconUsersGroup size={14} />}
					onClick={() => setGrouping(isGrouped ? [] : ["team"])}
				>
					<Trans>Group by team</Trans>
				</Button>
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
						{columnMenuItems.map((c) => (
							<Menu.Item
								key={c.id}
								onClick={(e) => e.preventDefault()}
								closeMenuOnClick={false}
							>
								<Checkbox
									size="xs"
									label={c.label}
									checked={columnVisibility[c.id] !== false}
									onChange={(e) =>
										setColumnVisibility((v) => ({
											...v,
											[c.id]: e.currentTarget.checked,
										}))
									}
								/>
							</Menu.Item>
						))}
					</Menu.Dropdown>
				</Menu>
				<Button
					size="xs"
					variant="default"
					leftSection={<IconDownload size={14} />}
					onClick={handleExport}
				>
					<Trans>Export CSV</Trans>
				</Button>
			</Group>

			<BillingTable
				columns={columns}
				data={prefiltered}
				globalFilter={globalFilter}
				onGlobalFilterChange={setGlobalFilter}
				columnFilters={columnFilters}
				onColumnFiltersChange={setColumnFilters}
				columnVisibility={columnVisibility}
				onColumnVisibilityChange={setColumnVisibility}
				grouping={grouping}
				onGroupingChange={setGrouping}
				initialSorting={[{ id: "total_forecast_eur", desc: true }]}
				footerTotals={footerTotals}
			/>

			<TierBreakdownPanel rows={prefiltered} />
			<Paper withBorder radius="sm" p="sm">
				<Stack gap={4}>
					<Text size="sm" fw={500}>
						<Trans>Pricing matrix</Trans>
					</Text>
					<Text size="xs" c="dimmed">
						<Trans>Every tier at a glance. Same table customers see on the workspace billing tab.</Trans>
					</Text>
					<Box mt="xs">
						<TierCapacityMatrix />
					</Box>
				</Stack>
			</Paper>

			<WorkspaceActionsModal
				row={actionsRow}
				opened={actionsRow !== null}
				onClose={() => setActionsRow(null)}
			/>
		</Stack>
	);
}

function SimpleDataTable<T extends object>({
	columns,
	data,
	globalFilter,
	onGlobalFilterChange,
	initialSorting,
	emptyLabel,
}: {
	columns: ColumnDef<T, unknown>[];
	data: T[];
	globalFilter: string;
	onGlobalFilterChange: (v: string) => void;
	initialSorting?: SortingState;
	emptyLabel: string;
}) {
	const [sorting, setSorting] = useState<SortingState>(initialSorting ?? []);
	const table = useReactTable<T>({
		columns,
		data,
		state: { sorting, globalFilter },
		onSortingChange: setSorting,
		onGlobalFilterChange,
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
	});
	const rows = table.getRowModel().rows;
	return (
		<Paper withBorder radius="sm" style={{ overflowX: "auto" }}>
			<Table striped highlightOnHover verticalSpacing="xs" fz="xs">
				<Table.Thead>
					{table.getHeaderGroups().map((hg) => (
						<Table.Tr key={hg.id}>
							{hg.headers.map((h) => {
								const canSort = h.column.getCanSort();
								const sorted = h.column.getIsSorted();
								const align =
									(h.column.columnDef.meta as { align?: "left" | "right" } | undefined)
										?.align ?? "left";
								return (
									<Table.Th key={h.id} ta={align}>
										{canSort ? (
											<UnstyledButton
												onClick={h.column.getToggleSortingHandler()}
												style={{ width: "100%" }}
											>
												<SortableHeader
													label={
														typeof h.column.columnDef.header === "string"
															? (h.column.columnDef.header as string)
															: ""
													}
													sorted={sorted}
													align={align}
												/>
											</UnstyledButton>
										) : (
											<Text size="xs" fw={500} c="dimmed" tt="uppercase" lts={0.3}>
												{flexRender(h.column.columnDef.header, h.getContext())}
											</Text>
										)}
									</Table.Th>
								);
							})}
						</Table.Tr>
					))}
				</Table.Thead>
				<Table.Tbody>
					{rows.length === 0 ? (
						<Table.Tr>
							<Table.Td colSpan={columns.length}>
								<Text size="xs" c="dimmed" ta="center" py="md">
									{emptyLabel}
								</Text>
							</Table.Td>
						</Table.Tr>
					) : (
						rows.map((row) => (
							<Table.Tr key={row.id}>
								{row.getVisibleCells().map((cell) => {
									const align =
										(cell.column.columnDef.meta as { align?: "left" | "right" } | undefined)
											?.align ?? "left";
									return (
										<Table.Td key={cell.id} ta={align}>
											{flexRender(cell.column.columnDef.cell, cell.getContext())}
										</Table.Td>
									);
								})}
							</Table.Tr>
						))
					)}
				</Table.Tbody>
			</Table>
		</Paper>
	);
}

function PartnersPanel() {
	const { data, isLoading } = useQuery({
		queryKey: ["v2", "admin", "referral-ledger"],
		queryFn: () => fetchJson<ReferralLedgerRow[]>("/v2/admin/referral-ledger"),
		staleTime: 60_000,
	});
	const [globalFilter, setGlobalFilter] = useState("");
	const columns = useMemo<ColumnDef<ReferralLedgerRow, unknown>[]>(
		() => [
			{
				id: "workspace_name",
				accessorFn: (r) => r.workspace_name ?? "",
				header: t`Workspace`,
				cell: ({ row }) =>
					row.original.workspace_id ? (
						<Anchor
							component={I18nLink}
							to={`/w/${row.original.workspace_id}/settings/billing`}
							size="xs"
							fw={500}
						>
							{row.original.workspace_name ?? row.original.workspace_id.slice(0, 8)}
						</Anchor>
					) : (
						<Text size="xs" c="dimmed">
							.
						</Text>
					),
			},
			{
				id: "partner_team_name",
				accessorFn: (r) => r.partner_team_name ?? "",
				header: t`Partner team`,
				cell: ({ row }) =>
					row.original.partner_team_id ? (
						<Anchor
							component={I18nLink}
							to={`/t/${row.original.partner_team_id}`}
							size="xs"
						>
							{row.original.partner_team_name ?? ""}
						</Anchor>
					) : (
						<Text size="xs" c="dimmed">
							.
						</Text>
					),
			},
			{
				id: "from_org_name",
				accessorFn: (r) => r.from_org_name ?? "",
				header: t`Client team`,
				cell: ({ row }) =>
					row.original.from_org_id ? (
						<Anchor
							component={I18nLink}
							to={`/t/${row.original.from_org_id}`}
							size="xs"
						>
							{row.original.from_org_name ?? ""}
						</Anchor>
					) : (
						<Text size="xs" c="dimmed">
							.
						</Text>
					),
			},
			{
				id: "partner_kickback_percent",
				accessorKey: "partner_kickback_percent",
				header: t`Kickback %`,
				meta: { align: "right" },
				cell: ({ row }) => {
					const v = row.original.partner_kickback_percent;
					return v == null ? "" : `${v}%`;
				},
			},
			{
				id: "to_team_discount_percent",
				accessorKey: "to_team_discount_percent",
				header: t`Client discount %`,
				meta: { align: "right" },
				cell: ({ row }) => {
					const v = row.original.to_team_discount_percent;
					return v == null ? "" : `${v}%`;
				},
			},
			{
				id: "eur_cap_kickback",
				accessorKey: "eur_cap_kickback",
				header: t`Lifetime cap`,
				meta: { align: "right" },
				cell: ({ row }) => formatEur(row.original.eur_cap_kickback),
			},
			{
				id: "starts_at",
				accessorKey: "starts_at",
				header: t`Starts`,
				cell: ({ row }) => formatDate(row.original.starts_at),
			},
			{
				id: "expires_at",
				accessorKey: "expires_at",
				header: t`Expires`,
				cell: ({ row }) => formatDate(row.original.expires_at) || t`no expiry`,
			},
			{
				id: "notes",
				accessorKey: "notes",
				header: t`Notes`,
				cell: ({ row }) => (
					<Text size="xs" c="dimmed" lineClamp={1} maw={220}>
						{row.original.notes ?? ""}
					</Text>
				),
			},
		],
		[],
	);
	if (isLoading) {
		return (
			<Center py="xl">
				<Loader size="sm" color="gray" />
			</Center>
		);
	}
	const rows = data ?? [];
	return (
		<Stack gap="sm">
			<Group justify="space-between" align="center" wrap="wrap">
				<Text size="xs" c="dimmed">
					<Plural value={rows.length} one="# agreement" other="# agreements" />
				</Text>
				<TextInput
					leftSection={<IconSearch size={14} />}
					placeholder={t`Search partner, client, workspace`}
					value={globalFilter}
					onChange={(e) => setGlobalFilter(e.currentTarget.value)}
					size="xs"
					style={{ maxWidth: 320 }}
				/>
			</Group>
			<SimpleDataTable<ReferralLedgerRow>
				columns={columns}
				data={rows}
				globalFilter={globalFilter}
				onGlobalFilterChange={setGlobalFilter}
				emptyLabel={t`No referral agreements yet.`}
			/>
		</Stack>
	);
}

function UpgradesPanel() {
	const { data, isLoading } = useQuery({
		queryKey: ["v2", "admin", "upgrade-requests"],
		queryFn: () => fetchJson<UpgradeRequestRow[]>("/v2/admin/upgrade-requests"),
		staleTime: 60_000,
	});
	const [globalFilter, setGlobalFilter] = useState("");
	const columns = useMemo<ColumnDef<UpgradeRequestRow, unknown>[]>(
		() => [
			{
				id: "workspace_name",
				accessorKey: "workspace_name",
				header: t`Workspace`,
				cell: ({ row }) => (
					<Anchor
						component={I18nLink}
						to={`/w/${row.original.workspace_id}/settings/billing`}
						size="xs"
						fw={500}
					>
						{row.original.workspace_name}
					</Anchor>
				),
			},
			{
				id: "org_name",
				accessorKey: "org_name",
				header: t`Team`,
				cell: ({ row }) => (
					<Text size="xs" c="dimmed">
						{row.original.org_name}
					</Text>
				),
			},
			{
				id: "current_tier",
				accessorFn: (r) => r.current_tier,
				sortingFn: (a, b) =>
					tierRank(a.original.current_tier) - tierRank(b.original.current_tier),
				header: t`Current tier`,
				cell: ({ row }) => (
					<Badge
						size="xs"
						color={tierColors[row.original.current_tier] ?? "gray"}
						variant="light"
						tt="capitalize"
					>
						{row.original.current_tier}
					</Badge>
				),
			},
			{
				id: "target_tier",
				accessorFn: (r) => r.target_tier,
				sortingFn: (a, b) =>
					tierRank(a.original.target_tier) - tierRank(b.original.target_tier),
				header: t`Target tier`,
				cell: ({ row }) => (
					<Badge
						size="xs"
						color={tierColors[row.original.target_tier] ?? "gray"}
						variant="filled"
						tt="capitalize"
					>
						{row.original.target_tier}
					</Badge>
				),
			},
			{
				id: "audio_hours_current",
				accessorKey: "audio_hours_current",
				header: t`Current hours`,
				meta: { align: "right" },
				cell: ({ row }) => (
					<UsageBar
						used={row.original.audio_hours_current}
						cap={row.original.audio_hours_included}
						unit="h"
					/>
				),
			},
			{
				id: "seat_count",
				accessorKey: "seat_count",
				header: t`Seats`,
				meta: { align: "right" },
				cell: ({ row }) => (
					<UsageBar
						used={row.original.seat_count}
						cap={row.original.seats_included}
					/>
				),
			},
			{
				id: "requested_at",
				accessorKey: "requested_at",
				header: t`Requested`,
				cell: ({ row }) => formatDate(row.original.requested_at),
			},
		],
		[],
	);
	if (isLoading) {
		return (
			<Center py="xl">
				<Loader size="sm" color="gray" />
			</Center>
		);
	}
	const rows = data ?? [];
	return (
		<Stack gap="sm">
			<Group justify="space-between" align="center" wrap="wrap">
				<Text size="xs" c="dimmed">
					<Plural value={rows.length} one="# request" other="# requests" />
				</Text>
				<TextInput
					leftSection={<IconSearch size={14} />}
					placeholder={t`Search workspace, team, tier`}
					value={globalFilter}
					onChange={(e) => setGlobalFilter(e.currentTarget.value)}
					size="xs"
					style={{ maxWidth: 320 }}
				/>
			</Group>
			<SimpleDataTable<UpgradeRequestRow>
				columns={columns}
				data={rows}
				globalFilter={globalFilter}
				onGlobalFilterChange={setGlobalFilter}
				emptyLabel={t`No pending upgrade requests.`}
			/>
		</Stack>
	);
}

export const AdminSettingsRoute = () => {
	useDocumentTitle(t`Admin, dembrane`);
	const { data: me } = useV2Me();
	const { tab } = useParams();
	const navigate = useNavigate();

	if (me && me.is_staff !== true) {
		return (
			<Container size="sm" py="xl">
				<Stack align="center" gap="sm" mt="15vh">
					<Title order={3} fw={400}>
						<Trans>Staff only</Trans>
					</Title>
					<Text c="dimmed" size="sm" ta="center">
						<Trans>
							This area is for dembrane staff. If you think you should have
							access, email support@dembrane.com.
						</Trans>
					</Text>
				</Stack>
			</Container>
		);
	}

	const active = (tab as string) || "usage-and-billing";

	return (
		<Container size="xl" py="xl" px="lg">
			<Stack gap="md">
				<Group justify="space-between" align="flex-end">
					<Stack gap={2}>
						<Group gap="xs" align="center">
							<Title order={3} fw={400}>
								<Trans>Admin</Trans>
							</Title>
							<Badge size="xs" color="violet" variant="light">
								<Trans>Staff</Trans>
							</Badge>
						</Group>
						<Text size="xs" c="dimmed">
							<Trans>
								Usage and billing, partner ledger, upgrade triage. Any Directus
								admin has access.
							</Trans>
						</Text>
					</Stack>
				</Group>
				<Tabs
					value={active}
					onChange={(v) => v && navigate(`/admin/${v}`, { replace: true })}
					keepMounted={false}
				>
					<Tabs.List>
						<Tabs.Tab value="usage-and-billing">
							<Trans>Usage and Billing</Trans>
						</Tabs.Tab>
						<Tabs.Tab value="partners">
							<Trans>Partners</Trans>
						</Tabs.Tab>
						<Tabs.Tab value="upgrades">
							<Trans>Upgrades</Trans>
						</Tabs.Tab>
					</Tabs.List>
					<Tabs.Panel value="usage-and-billing" pt="md">
						<UsageAndBillingPanel />
					</Tabs.Panel>
					<Tabs.Panel value="partners" pt="md">
						<PartnersPanel />
					</Tabs.Panel>
					<Tabs.Panel value="upgrades" pt="md">
						<UpgradesPanel />
					</Tabs.Panel>
				</Tabs>
			</Stack>
		</Container>
	);
};
