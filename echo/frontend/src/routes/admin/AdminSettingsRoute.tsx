import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	Anchor,
	Badge,
	Box,
	Button,
	Center,
	Collapse,
	Container,
	Group,
	Loader,
	Paper,
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
	IconChevronDown,
	IconChevronRight,
	IconDownload,
	IconSearch,
	IconSortAscending,
	IconSortDescending,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import {
	type ColumnDef,
	type SortingState,
	type ColumnFiltersState,
	flexRender,
	getCoreRowModel,
	getFilteredRowModel,
	getSortedRowModel,
	useReactTable,
	type Row,
} from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { I18nLink } from "@/components/common/i18nLink";
import { API_BASE_URL } from "@/config";
import { useV2Me } from "@/hooks/useV2Me";

// Ordered tier list for custom sorting. Matrix v1.1 §1 order from low to high.
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
	total_base_eur: number;
	total_overage_eur: number;
	total_forecast_eur: number;
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
 * Download a CSV of whatever rows are currently visible (after filters
 * and sort). Takes the table's filtered + sorted rows so "Export CSV"
 * matches what staff is looking at.
 */
function downloadRowsAsCsv<T extends Record<string, unknown>>(
	filename: string,
	rows: Row<T>[],
	columns: { id: string; header: string; accessor: (row: T) => unknown }[],
) {
	const headerLine = columns.map((c) => c.header).join(",");
	const lines = rows.map((r) =>
		columns
			.map((c) => {
				const v = c.accessor(r.original);
				const s = v == null ? "" : String(v);
				return `"${s.replace(/"/g, '""')}"`;
			})
			.join(","),
	);
	const csv = [headerLine, ...lines].join("\n");
	const blob = new Blob([csv], { type: "text/csv" });
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	link.click();
	URL.revokeObjectURL(url);
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
		<Group gap={4} wrap="nowrap" justify={align === "right" ? "flex-end" : "flex-start"}>
			<Text size="xs" fw={500} c="dimmed" tt="uppercase" lts={0.3}>
				{label}
			</Text>
			{sorted === "asc" && <IconSortAscending size={12} color="var(--mantine-color-gray-6)" />}
			{sorted === "desc" && <IconSortDescending size={12} color="var(--mantine-color-gray-6)" />}
		</Group>
	);
}

/**
 * Thin wrapper that wires a TanStack Table into a Mantine table shell.
 * Keeps sort, filter, and global-search state per instance. Rendering
 * uses flexRender so column defs can return anything.
 */
function DataTable<T extends object>({
	columns,
	data,
	globalFilter,
	onGlobalFilterChange,
	initialSorting,
	emptyLabel,
	columnFilters,
	onColumnFiltersChange,
}: {
	columns: ColumnDef<T, unknown>[];
	data: T[];
	globalFilter: string;
	onGlobalFilterChange: (v: string) => void;
	initialSorting?: SortingState;
	emptyLabel: string;
	columnFilters?: ColumnFiltersState;
	onColumnFiltersChange?: (u: ColumnFiltersState) => void;
}) {
	const [sorting, setSorting] = useState<SortingState>(initialSorting ?? []);

	const table = useReactTable<T>({
		columns,
		data,
		state: {
			sorting,
			globalFilter,
			columnFilters: columnFilters ?? [],
		},
		onSortingChange: setSorting,
		onGlobalFilterChange,
		onColumnFiltersChange: onColumnFiltersChange
			? (updater) => {
					const next =
						typeof updater === "function"
							? updater(columnFilters ?? [])
							: updater;
					onColumnFiltersChange(next);
				}
			: undefined,
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
	});

	const rows = table.getRowModel().rows;

	return (
		<Paper withBorder radius="sm" style={{ overflowX: "auto" }}>
			<Table striped highlightOnHover verticalSpacing="xs" fz="xs">
				<Table.Thead>
					{table.getHeaderGroups().map((headerGroup) => (
						<Table.Tr key={headerGroup.id}>
							{headerGroup.headers.map((header) => {
								const canSort = header.column.getCanSort();
								const sorted = header.column.getIsSorted();
								const align = (header.column.columnDef.meta as { align?: "left" | "right" } | undefined)?.align ?? "left";
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
											<Text size="xs" fw={500} c="dimmed" tt="uppercase" lts={0.3}>
												{flexRender(header.column.columnDef.header, header.getContext())}
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
									const align = (cell.column.columnDef.meta as { align?: "left" | "right" } | undefined)?.align ?? "left";
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

function TierBreakdownPanel({ rows }: { rows: BillingRow[] }) {
	const [opened, { toggle }] = useDisclosure(false);

	const byTier = useMemo(() => {
		const groups = new Map<string, { count: number; base: number; overage: number; active: number }>();
		for (const t of TIER_ORDER) {
			groups.set(t, { count: 0, base: 0, overage: 0, active: 0 });
		}
		for (const r of rows) {
			const g = groups.get(r.tier) ?? { count: 0, base: 0, overage: 0, active: 0 };
			g.count += 1;
			g.base += r.base_price_eur ?? 0;
			g.overage += r.hour_overage_eur + r.seat_overage_eur;
			if (r.is_active) g.active += 1;
			groups.set(r.tier, g);
		}
		return TIER_ORDER.map((tier) => ({ tier, ...(groups.get(tier) ?? { count: 0, base: 0, overage: 0, active: 0 }) }));
	}, [rows]);

	return (
		<Paper withBorder radius="sm" p="sm">
			<UnstyledButton onClick={toggle} style={{ width: "100%" }}>
				<Group justify="space-between" wrap="nowrap">
					<Group gap="xs">
						{opened ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
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
									<Badge size="xs" color={tierColors[b.tier] ?? "gray"} variant="light" tt="capitalize">
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
	const { data, isLoading } = useQuery({
		queryKey: ["v2", "admin", "billing-rollup"],
		queryFn: () => fetchJson<BillingRollup>("/v2/admin/billing-rollup"),
		staleTime: 60_000,
	});

	const [globalFilter, setGlobalFilter] = useState("");
	const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
	const [onlyOver, setOnlyOver] = useState(false);
	const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");

	// Pre-filter: over-cap + status happen outside TanStack so the table
	// only sees rows the staff actually wants. Column-level filters (per-
	// tier) still go through the table state.
	const prefiltered = useMemo(() => {
		const rows = data?.rows ?? [];
		return rows.filter((r) => {
			if (onlyOver && r.hour_overage_eur === 0 && r.seat_overage_eur === 0)
				return false;
			if (statusFilter === "active" && !r.is_active) return false;
			if (statusFilter === "inactive" && r.is_active) return false;
			return true;
		});
	}, [data, onlyOver, statusFilter]);

	const columns = useMemo<ColumnDef<BillingRow, unknown>[]>(() => {
		return [
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
				id: "billed_to",
				accessorFn: (r) => r.billed_to_team_name ?? r.org_name,
				header: t`Team`,
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
				// Sort by the canonical tier order, not alphabetic. matrix v1.1 §1.
				accessorFn: (r) => r.tier,
				sortingFn: (a, b) => tierRank(a.original.tier) - tierRank(b.original.tier),
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
				id: "audio_hours",
				accessorKey: "audio_hours",
				header: t`Hours`,
				meta: { align: "right" },
				cell: ({ row }) => {
					const r = row.original;
					const txt = r.audio_hours_included
						? `${r.audio_hours.toFixed(1)} / ${r.audio_hours_included}`
						: r.audio_hours.toFixed(1);
					return (
						<Text size="xs" c={r.at_cap || r.pilot_hard_block ? "red" : undefined}>
							{txt}
						</Text>
					);
				},
			},
			{
				id: "seat_count",
				accessorKey: "seat_count",
				header: t`Seats`,
				meta: { align: "right" },
				cell: ({ row }) => {
					const r = row.original;
					return r.seats_included
						? `${r.seat_count} / ${r.seats_included}`
						: `${r.seat_count}`;
				},
			},
			{
				id: "base_price_eur",
				accessorKey: "base_price_eur",
				header: t`Base`,
				meta: { align: "right" },
				cell: ({ row }) => formatEur(row.original.base_price_eur),
			},
			{
				id: "overage_total",
				accessorFn: (r) => r.hour_overage_eur + r.seat_overage_eur,
				header: t`Overage`,
				meta: { align: "right" },
				cell: ({ row }) => {
					const v = row.original.hour_overage_eur + row.original.seat_overage_eur;
					return (
						<Text size="xs" c={v > 0 ? "orange" : "dimmed"}>
							{formatEur(v)}
						</Text>
					);
				},
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
				id: "workspace_admin",
				accessorFn: (r) => r.workspace_admins[0]?.email ?? "",
				header: t`Workspace admin`,
				cell: ({ row }) => {
					const admins = row.original.workspace_admins;
					if (admins.length === 0) {
						return (
							<Text size="xs" c="dimmed">
								.
							</Text>
						);
					}
					const first = admins[0];
					const others = admins
						.map((a) => `${a.display_name ?? "?"} ${a.email ?? ""}`)
						.join(" / ");
					return (
						<Tooltip label={others} withArrow>
							<Text size="xs" c="dimmed" truncate maw={160}>
								{first.email ?? first.display_name ?? ""}
							</Text>
						</Tooltip>
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
		];
	}, []);

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
		// Rebuild a simplified row set for CSV to keep it invoice-ready.
		const exportColumns = [
			{ id: "workspace_id", header: "workspace_id", accessor: (r: BillingRow) => r.workspace_id },
			{ id: "workspace_name", header: "workspace_name", accessor: (r: BillingRow) => r.workspace_name },
			{ id: "team", header: "team", accessor: (r: BillingRow) => r.billed_to_team_name ?? r.org_name },
			{ id: "tier", header: "tier", accessor: (r: BillingRow) => r.tier },
			{ id: "audio_hours", header: "audio_hours", accessor: (r: BillingRow) => r.audio_hours.toFixed(2) },
			{ id: "audio_hours_included", header: "audio_hours_included", accessor: (r: BillingRow) => r.audio_hours_included ?? "" },
			{ id: "hour_overage_eur", header: "hour_overage_eur", accessor: (r: BillingRow) => r.hour_overage_eur.toFixed(2) },
			{ id: "seat_count", header: "seat_count", accessor: (r: BillingRow) => r.seat_count },
			{ id: "seats_included", header: "seats_included", accessor: (r: BillingRow) => r.seats_included ?? "" },
			{ id: "seat_overage_eur", header: "seat_overage_eur", accessor: (r: BillingRow) => r.seat_overage_eur.toFixed(2) },
			{ id: "base_price_eur", header: "base_price_eur", accessor: (r: BillingRow) => r.base_price_eur ?? "" },
			{ id: "total_forecast_eur", header: "total_forecast_eur", accessor: (r: BillingRow) => r.total_forecast_eur ?? "" },
			{ id: "workspace_admin_email", header: "workspace_admin_email", accessor: (r: BillingRow) => r.workspace_admins[0]?.email ?? "" },
			{ id: "is_active", header: "is_active", accessor: (r: BillingRow) => (r.is_active ? "yes" : "no") },
		];
		const fakeRows = prefiltered.map((r, i) => ({ id: String(i), original: r } as Row<BillingRow>));
		downloadRowsAsCsv(
			`usage-and-billing-${data.cycle_start.slice(0, 7)}.csv`,
			fakeRows,
			exportColumns,
		);
	};

	return (
		<Stack gap="md">
			<Group justify="space-between" align="center" wrap="wrap">
				<Stack gap={2}>
					<Text size="sm" c="dimmed">
						<Trans>
							Usage and billing, {cycleLabel}, {" "}
							<Plural value={data.workspace_count} one="# workspace" other="# workspaces" />
						</Trans>
					</Text>
					<Group gap="md">
						<Text size="xs" c="dimmed">
							<Trans>Base</Trans> {formatEur(data.total_base_eur)}
						</Text>
						<Text size="xs" c="dimmed">
							<Trans>Overage</Trans> {formatEur(data.total_overage_eur)}
						</Text>
						<Text size="sm" fw={500}>
							<Trans>Total forecast</Trans> {formatEur(data.total_forecast_eur)}
						</Text>
					</Group>
				</Stack>
				<Group gap="xs">
					<Button
						size="xs"
						variant="default"
						leftSection={<IconDownload size={14} />}
						onClick={handleExport}
					>
						<Trans>Export CSV</Trans>
					</Button>
				</Group>
			</Group>

			<Group gap="sm" wrap="wrap">
				<TextInput
					leftSection={<IconSearch size={14} />}
					placeholder={t`Search workspace, team, email, tier`}
					value={globalFilter}
					onChange={(e) => setGlobalFilter(e.currentTarget.value)}
					size="sm"
					style={{ flex: 1, maxWidth: 360 }}
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
						color={statusFilter === "inactive" ? "gray" : "gray"}
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
			</Group>

			<DataTable<BillingRow>
				columns={columns}
				data={prefiltered}
				globalFilter={globalFilter}
				onGlobalFilterChange={setGlobalFilter}
				columnFilters={columnFilters}
				onColumnFiltersChange={setColumnFilters}
				initialSorting={[{ id: "total_forecast_eur", desc: true }]}
				emptyLabel={t`Nothing matches the filter.`}
			/>

			<TierBreakdownPanel rows={prefiltered} />
		</Stack>
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
			<DataTable<ReferralLedgerRow>
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
				sortingFn: (a, b) => tierRank(a.original.current_tier) - tierRank(b.original.current_tier),
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
				sortingFn: (a, b) => tierRank(a.original.target_tier) - tierRank(b.original.target_tier),
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
				cell: ({ row }) => {
					const r = row.original;
					return r.audio_hours_included
						? `${r.audio_hours_current.toFixed(1)} / ${r.audio_hours_included}`
						: r.audio_hours_current.toFixed(1);
				},
			},
			{
				id: "seat_count",
				accessorKey: "seat_count",
				header: t`Seats`,
				meta: { align: "right" },
				cell: ({ row }) => {
					const r = row.original;
					return r.seats_included
						? `${r.seat_count} / ${r.seats_included}`
						: `${r.seat_count}`;
				},
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
			<DataTable<UpgradeRequestRow>
				columns={columns}
				data={rows}
				globalFilter={globalFilter}
				onGlobalFilterChange={setGlobalFilter}
				emptyLabel={t`No pending upgrade requests. Requests currently email the upgrade inbox and are not yet persisted.`}
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
								admin has access. Staff policy wiring (matrix section 11) lands
								in a follow-up.
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
