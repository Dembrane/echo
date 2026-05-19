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
	NumberInput,
	Paper,
	Progress,
	Select,
	SimpleGrid,
	Stack,
	Table,
	Tabs,
	Text,
	Textarea,
	TextInput,
	Title,
	Tooltip,
	UnstyledButton,
	useModalsStack,
} from "@mantine/core";
import { useDisclosure, useDocumentTitle } from "@mantine/hooks";
import {
	IconAdjustments,
	IconArrowsSort,
	IconChevronDown,
	IconChevronRight,
	IconDots,
	IconDownload,
	IconEye,
	IconSearch,
	IconSortAscending,
	IconSortDescending,
	IconUsersGroup,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	type ColumnDef,
	type ColumnFiltersState,
	flexRender,
	type GroupingState,
	getCoreRowModel,
	getExpandedRowModel,
	getFilteredRowModel,
	getGroupedRowModel,
	getSortedRowModel,
	type Row,
	type SortingState,
	useReactTable,
	type VisibilityState,
} from "@tanstack/react-table";
import { formatDistance } from "date-fns";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { I18nLink } from "@/components/common/i18nLink";
import { UsageFreshness } from "@/components/common/UsageFreshness";
import { TierCapacityMatrix } from "@/components/workspace/TierCapacityMatrix";
import { TierPricingCards } from "@/components/workspace/TierPricingCards";
import { API_BASE_URL } from "@/config";
import { useV2Me } from "@/hooks/useV2Me";
import { type Tier, TIER_ORDER } from "@/lib/tiers";
import { formatDurationFromHours } from "@/lib/time";

const tierRank = (tier: string): number => TIER_ORDER.indexOf(tier as Tier);

const tierColors: Record<string, string> = {
	changemaker: "grape",
	free: "gray",
	guardian: "orange",
	innovator: "violet",
	pilot: "gray",
	pioneer: "primary",
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
	guest_count: number;
	base_price_eur: number | null;
	total_forecast_eur: number | null;
	pilot_hard_block: boolean;
	approaching_cap: boolean;
	at_cap: boolean;
	downgraded_at: string | null;
	downgraded_from_tier: string | null;
	is_active: boolean;
	workspace_admins: BillingContact[];
	tier_expires_at: string | null;
	type_discount: string | null;
	percent_discount: number | null;
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
	to_organisation_discount_percent: number | null;
	eur_cap_kickback: number | null;
	starts_at: string | null;
	expires_at: string | null;
	notes: string | null;
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
		{ label: t`This month`, offset: 0 },
		{ label: t`Last month`, offset: -1 },
		{ label: t`2 months ago`, offset: -2 },
		{ label: t`3 months ago`, offset: -3 },
	];
	return (
		<Button.Group>
			{options.map((opt) => (
				<Button
					key={opt.offset}
					size="xs"
					variant={value === opt.offset ? "filled" : "default"}
					color={value === opt.offset ? "primary" : "gray"}
					onClick={() => onChange(opt.offset)}
				>
					{opt.label}
				</Button>
			))}
		</Button.Group>
	);
}

/**
 * Header cell for a sortable column. Renders a faint sort handle by
 * default so the column advertises that it's sortable — otherwise
 * staff had no way to tell except clicking blindly. Active sort
 * replaces the handle with a darker asc/desc icon.
 */
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
 * Inline usage bar. primary under 60 percent, yellow 60 to 90, red over
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
					: "primary";
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
 * Inline discount editor used in WorkspaceActionsModal.
 */
function DiscountEditor({
	workspaceId,
	initialType,
	initialPercent,
}: {
	workspaceId: string;
	initialType: string | null;
	initialPercent: number | null;
}) {
	const queryClient = useQueryClient();
	const [typeDiscount, setTypeDiscount] = useState<string | null>(initialType);
	const [percentDiscount, setPercentDiscount] = useState<number | string>(
		initialPercent ?? "",
	);

	const hasChanges =
		typeDiscount !== initialType ||
		(percentDiscount !== "" ? Number(percentDiscount) : null) !==
			initialPercent;

	const mutation = useMutation({
		mutationFn: async () => {
			const body: Record<string, unknown> = {};
			if (typeDiscount !== initialType) {
				if (typeDiscount) {
					body.type_discount = typeDiscount;
				} else {
					body.clear_type_discount = true;
				}
			}
			const pct = percentDiscount !== "" ? Number(percentDiscount) : null;
			if (pct !== initialPercent) {
				if (pct != null) {
					body.percent_discount = pct;
				} else {
					body.clear_percent_discount = true;
				}
			}
			const res = await fetch(
				`${API_BASE_URL}/v2/admin/workspaces/${workspaceId}/discount`,
				{
					body: JSON.stringify(body),
					credentials: "include",
					headers: { "Content-Type": "application/json" },
					method: "PATCH",
				},
			);
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				throw new Error(err.detail || `Failed (${res.status})`);
			}
			return res.json();
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["v2", "admin", "billing-rollup"],
			});
		},
	});

	return (
		<Paper withBorder radius="sm" p="sm">
			<Stack gap="xs">
				<Text size="sm" fw={500}>
					<Trans>Discount</Trans>
				</Text>
				<SimpleGrid cols={2}>
					<Select
						label={t`Type`}
						data={[
							{ label: "Scholarship", value: "scholarship" },
							{
								label: "Staff discount",
								value: "staff_discount",
							},
						]}
						value={typeDiscount}
						onChange={setTypeDiscount}
						clearable
						size="xs"
					/>
					<NumberInput
						label={t`Percent`}
						min={0}
						max={100}
						value={percentDiscount}
						onChange={setPercentDiscount}
						size="xs"
					/>
				</SimpleGrid>
				{mutation.isError && (
					<Text size="xs" c="red">
						{(mutation.error as Error).message}
					</Text>
				)}
				{mutation.isSuccess && (
					<Text size="xs" c="primary">
						<Trans>Saved</Trans>
					</Text>
				)}
				<Button
					size="xs"
					variant="light"
					disabled={!hasChanges}
					loading={mutation.isPending}
					onClick={() => mutation.mutate()}
				>
					<Trans>Save discount</Trans>
				</Button>
			</Stack>
		</Paper>
	);
}

/**
 * Actions modal for a workspace row. Includes the discount editor
 * (live, staff-only) and mocked placeholders for future actions.
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
			hint: t`Pick a new tier and apply downgrade effects per matrix.`,
			label: t`Change tier`,
		},
		{
			hint: t`Transfer the primary admin role to another member.`,
			label: t`Change workspace admin`,
		},
		{
			hint: t`Back out this cycle's hour count after a support incident.`,
			label: t`Reset monthly usage`,
		},
		{
			hint: t`Partner handoff. Writes billed_to_team_id and notifies both organisations.`,
			label: t`Transfer workspace to another organisation`,
		},
		{
			color: "red",
			hint: t`Permanent. Removes all conversations and data.`,
			label: t`Delete workspace`,
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

				<DiscountEditor
					workspaceId={row.workspace_id}
					initialType={row.type_discount ?? null}
					initialPercent={row.percent_discount ?? null}
				/>

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
		autoResetExpanded: false,
		columns,
		data,
		getCoreRowModel: getCoreRowModel(),
		getExpandedRowModel: getExpandedRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
		getGroupedRowModel: getGroupedRowModel(),
		getSortedRowModel: getSortedRowModel(),
		// 'reorder' (default) moves grouped columns to the front so organisation
		// renders first when group-by-organisation is active; being explicit here
		// makes that contract impossible to miss during future edits.
		groupedColumnMode: "reorder",
		onColumnFiltersChange: (updater) =>
			onColumnFiltersChange(
				typeof updater === "function" ? updater(columnFilters) : updater,
			),
		onColumnVisibilityChange: (updater) =>
			onColumnVisibilityChange(
				typeof updater === "function" ? updater(columnVisibility) : updater,
			),
		onExpandedChange: (updater) => {
			const next = typeof updater === "function" ? updater(expanded) : updater;
			// Reject the 'true' shorthand; we never set that state.
			if (next === true) return;
			setExpanded(next as Record<string, boolean>);
		},
		onGlobalFilterChange,
		onGroupingChange: (updater) =>
			onGroupingChange(
				typeof updater === "function" ? updater(grouping) : updater,
			),
		onSortingChange: setSorting,
		state: {
			columnFilters,
			columnVisibility,
			expanded,
			globalFilter,
			grouping,
			sorting,
		},
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
									<Table.Th key={header.id} ta={align} style={{ padding: 0 }}>
										{canSort ? (
											<UnstyledButton
												onClick={header.column.getToggleSortingHandler()}
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
													e.currentTarget.style.background = "transparent";
												}}
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
											<Box px={12} py={8}>
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
											</Box>
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
								const groupValue = String(
									row.getValue(row.groupingColumnId ?? ""),
								);
								const descendants = row.getLeafRows();
								const organisationBase = descendants.reduce(
									(s, r) => s + (r.original.base_price_eur ?? 0),
									0,
								);
								const organisationOverage = descendants.reduce(
									(s, r) =>
										s +
										r.original.hour_overage_eur +
										r.original.seat_overage_eur,
									0,
								);
								const organisationTotal = descendants.reduce(
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
															{groupValue || t`Unassigned organisation`}
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
															<Trans>Base</Trans> {formatEur(organisationBase)}
														</Text>
														<Text size="xs" c="dimmed">
															<Trans>Overage</Trans>{" "}
															{formatEur(organisationOverage)}
														</Text>
														<Text size="xs" fw={500}>
															<Trans>Total</Trans>{" "}
															{formatEur(organisationTotal)}
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
												{flexRender(
													cell.column.columnDef.cell,
													cell.getContext(),
												)}
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
								// moves organisation to leaf[0]).
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
											{formatDurationFromHours(footerTotals.audio_hours)}
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
												footerTotals.hour_overage_eur > 0 ? "orange" : undefined
											}
										>
											{formatEur(footerTotals.hour_overage_eur)}
										</Text>
									),
									seat_count: (
										<Text size="xs" fw={600} ta="right">
											{footerTotals.seat_count}
										</Text>
									),
									seat_overage_eur: (
										<Text
											size="xs"
											fw={600}
											ta="right"
											c={
												footerTotals.seat_overage_eur > 0 ? "orange" : undefined
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
			groups.set(tier, { active: 0, base: 0, count: 0, overage: 0 });
		}
		for (const r of rows) {
			const g = groups.get(r.tier) ?? {
				active: 0,
				base: 0,
				count: 0,
				overage: 0,
			};
			g.count += 1;
			g.base += r.base_price_eur ?? 0;
			g.overage += r.hour_overage_eur + r.seat_overage_eur;
			if (r.is_active) g.active += 1;
			groups.set(r.tier, g);
		}
		return TIER_ORDER.map((tier) => ({
			tier,
			...(groups.get(tier) ?? { active: 0, base: 0, count: 0, overage: 0 }),
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
						<Plural
							value={rows.length}
							one="# workspace"
							other="# workspaces"
						/>
					</Text>
				</Group>
			</UnstyledButton>
			<Collapse in={opened}>
				<Box mt="sm">
					<SimpleGrid cols={{ base: 2, md: 5, sm: 3 }} spacing="sm">
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
	const [refreshing, setRefreshing] = useState(false);
	const { data, isLoading, dataUpdatedAt, refetch } = useQuery({
		queryFn: () =>
			fetchJson<BillingRollup>(
				`/v2/admin/billing-rollup?month_offset=${periodOffset}`,
			),
		queryKey: ["v2", "admin", "billing-rollup", periodOffset],
		staleTime: 60_000,
	});
	const handleRefresh = async () => {
		setRefreshing(true);
		try {
			await refetch();
		} finally {
			setRefreshing(false);
		}
	};

	const [globalFilter, setGlobalFilter] = useState("");
	const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
	const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
	const [grouping, setGrouping] = useState<GroupingState>([]);
	const [onlyOver, setOnlyOver] = useState(false);
	const [statusFilter, setStatusFilter] = useState<
		"all" | "active" | "inactive"
	>("all");
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
				accessorKey: "workspace_name",
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
				// Workspace name anchors the whole row — if the user hides
				// it, the total row + every other column becomes unreadable.
				// The menu already filters it out; this belts-and-braces
				// prevents it via a stray columnVisibility write too.
				enableHiding: false,
				header: t`Workspace`,
				id: "workspace_name",
			},
			{
				accessorFn: (r) => r.billed_to_team_name ?? r.org_name,
				cell: ({ row }) => (
					<Group gap={4} wrap="nowrap">
						<Anchor
							component={I18nLink}
							to={`/o/${row.original.org_id}`}
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
				// Used for grouping; the grouped-row renderer in BillingTable
				// reads this to label the header.
				getGroupingValue: (r) => r.billed_to_team_name ?? r.org_name,
				header: t`Organisation`,
				id: "organisation",
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
				accessorKey: "base_price_eur",
				cell: ({ row }) => formatEur(row.original.base_price_eur),
				header: t`Base`,
				id: "base_price_eur",
				meta: { align: "right" },
			},
			{
				accessorKey: "audio_hours",
				cell: ({ row }) => (
					<UsageBar
						used={row.original.audio_hours}
						cap={row.original.audio_hours_included}
						unit="h"
						block={row.original.pilot_hard_block}
					/>
				),
				header: t`Hours`,
				id: "audio_hours",
				meta: { align: "right" },
			},
			{
				accessorKey: "hour_overage_eur",
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
								{formatDurationFromHours(over)} over
							</Text>
						</Stack>
					);
				},
				header: t`Overage hrs`,
				id: "hour_overage_eur",
				meta: { align: "right" },
			},
			{
				accessorKey: "seat_count",
				cell: ({ row }) => (
					<UsageBar
						used={row.original.seat_count}
						cap={row.original.seats_included}
					/>
				),
				header: t`Seats`,
				id: "seat_count",
				meta: { align: "right" },
			},
			{
				accessorKey: "seat_overage_eur",
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
				header: t`Overage seats`,
				id: "seat_overage_eur",
				meta: { align: "right" },
			},
			{
				accessorFn: (r) => (r.is_active ? "active" : "inactive"),
				cell: ({ row }) =>
					row.original.is_active ? (
						<Badge size="xs" color="primary" variant="light">
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
			{
				accessorKey: "total_forecast_eur",
				cell: ({ row }) => (
					<Text size="xs" fw={500}>
						{formatEur(row.original.total_forecast_eur)}
					</Text>
				),
				header: t`Total`,
				id: "total_forecast_eur",
				meta: { align: "right" },
			},
			{
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
				enableGrouping: false,
				enableHiding: false,
				enableSorting: false,
				header: "",
				id: "actions",
			},
		],
		[],
	);

	const footerTotals = useMemo(
		() => ({
			audio_hours: prefiltered.reduce((s, r) => s + r.audio_hours, 0),
			base_price_eur: prefiltered.reduce(
				(s, r) => s + (r.base_price_eur ?? 0),
				0,
			),
			hour_overage_eur: prefiltered.reduce((s, r) => s + r.hour_overage_eur, 0),
			seat_count: prefiltered.reduce((s, r) => s + r.seat_count, 0),
			seat_overage_eur: prefiltered.reduce((s, r) => s + r.seat_overage_eur, 0),
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
			"organisation",
			"tier",
			"tier_expires_at",
			"type_discount",
			"percent_discount",
			"audio_hours",
			"audio_hours_included",
			"hour_overage_eur",
			"seat_count",
			"seats_included",
			"seat_overage_eur",
			"guest_count",
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
				r.tier_expires_at ?? "",
				r.type_discount ?? "",
				r.percent_discount ?? "",
				r.audio_hours.toFixed(2),
				r.audio_hours_included ?? "",
				r.hour_overage_eur.toFixed(2),
				r.seat_count,
				r.seats_included ?? "",
				r.seat_overage_eur.toFixed(2),
				r.guest_count,
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
		label: t.charAt(0).toUpperCase() + t.slice(1),
		value: t,
	}));

	// Column visibility menu: let staff hide noisy columns.
	const columnMenuItems = columns
		.filter((c) => c.id && c.id !== "actions" && c.id !== "workspace_name")
		.map((c) => ({
			id: c.id ?? "",
			label: typeof c.header === "string" ? (c.header as string) : (c.id ?? ""),
		}));

	const isGrouped = grouping.includes("organisation");

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
					placeholder={t`Search workspace, organisation, email, tier`}
					value={globalFilter}
					onChange={(e) => setGlobalFilter(e.currentTarget.value)}
					size="sm"
					style={{ flex: 1, maxWidth: 360, minWidth: 220 }}
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
						color={statusFilter === "all" ? "primary" : "gray"}
						onClick={() => setStatusFilter("all")}
					>
						<Trans>All</Trans>
					</Button>
					<Button
						size="xs"
						variant={statusFilter === "active" ? "filled" : "default"}
						color={statusFilter === "active" ? "primary" : "gray"}
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
					color={isGrouped ? "primary" : "gray"}
					leftSection={<IconUsersGroup size={14} />}
					onClick={() => setGrouping(isGrouped ? [] : ["organisation"])}
				>
					<Trans>Group by organisation</Trans>
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
				initialSorting={[{ desc: true, id: "total_forecast_eur" }]}
				footerTotals={footerTotals}
			/>

			<TierBreakdownPanel rows={prefiltered} />
			<Paper withBorder radius="sm" p="sm">
				<Stack gap={4}>
					<Text size="sm" fw={500}>
						<Trans>Pricing matrix</Trans>
					</Text>
					<Text size="xs" c="dimmed">
						<Trans>
							Every tier at a glance. Same table customers see on the workspace
							billing tab.
						</Trans>
					</Text>
					<Box mt="xs">
						<TierCapacityMatrix />
					</Box>
				</Stack>
			</Paper>

			<UsageFreshness
				dataUpdatedAt={dataUpdatedAt}
				refreshing={refreshing}
				onRefresh={handleRefresh}
			/>

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
		getCoreRowModel: getCoreRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
		getSortedRowModel: getSortedRowModel(),
		onGlobalFilterChange,
		onSortingChange: setSorting,
		state: { globalFilter, sorting },
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
									(
										h.column.columnDef.meta as
											| { align?: "left" | "right" }
											| undefined
									)?.align ?? "left";
								return (
									<Table.Th key={h.id} ta={align} style={{ padding: 0 }}>
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
													e.currentTarget.style.background = "transparent";
												}}
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
										(
											cell.column.columnDef.meta as
												| { align?: "left" | "right" }
												| undefined
										)?.align ?? "left";
									return (
										<Table.Td key={cell.id} ta={align}>
											{flexRender(
												cell.column.columnDef.cell,
												cell.getContext(),
											)}
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
		queryFn: () => fetchJson<ReferralLedgerRow[]>("/v2/admin/referral-ledger"),
		queryKey: ["v2", "admin", "referral-ledger"],
		staleTime: 60_000,
	});
	const [globalFilter, setGlobalFilter] = useState("");
	const columns = useMemo<ColumnDef<ReferralLedgerRow, unknown>[]>(
		() => [
			{
				accessorFn: (r) => r.workspace_name ?? "",
				cell: ({ row }) =>
					row.original.workspace_id ? (
						<Anchor
							component={I18nLink}
							to={`/w/${row.original.workspace_id}/settings/billing`}
							size="xs"
							fw={500}
						>
							{row.original.workspace_name ??
								row.original.workspace_id.slice(0, 8)}
						</Anchor>
					) : (
						<Text size="xs" c="dimmed">
							.
						</Text>
					),
				header: t`Workspace`,
				id: "workspace_name",
			},
			{
				accessorFn: (r) => r.partner_team_name ?? "",
				cell: ({ row }) =>
					row.original.partner_team_id ? (
						<Anchor
							component={I18nLink}
							to={`/o/${row.original.partner_team_id}`}
							size="xs"
						>
							{row.original.partner_team_name ?? ""}
						</Anchor>
					) : (
						<Text size="xs" c="dimmed">
							.
						</Text>
					),
				header: t`Partner organisation`,
				id: "partner_team_name",
			},
			{
				accessorFn: (r) => r.from_org_name ?? "",
				cell: ({ row }) =>
					row.original.from_org_id ? (
						<Anchor
							component={I18nLink}
							to={`/o/${row.original.from_org_id}`}
							size="xs"
						>
							{row.original.from_org_name ?? ""}
						</Anchor>
					) : (
						<Text size="xs" c="dimmed">
							.
						</Text>
					),
				header: t`Client organisation`,
				id: "from_org_name",
			},
			{
				accessorKey: "partner_kickback_percent",
				cell: ({ row }) => {
					const v = row.original.partner_kickback_percent;
					return v == null ? "" : `${v}%`;
				},
				header: t`Kickback %`,
				id: "partner_kickback_percent",
				meta: { align: "right" },
			},
			{
				accessorKey: "to_organisation_discount_percent",
				cell: ({ row }) => {
					const v = row.original.to_organisation_discount_percent;
					return v == null ? "" : `${v}%`;
				},
				header: t`Client discount %`,
				id: "to_organisation_discount_percent",
				meta: { align: "right" },
			},
			{
				accessorKey: "eur_cap_kickback",
				cell: ({ row }) => formatEur(row.original.eur_cap_kickback),
				header: t`Lifetime cap`,
				id: "eur_cap_kickback",
				meta: { align: "right" },
			},
			{
				accessorKey: "starts_at",
				cell: ({ row }) => formatDate(row.original.starts_at),
				header: t`Starts`,
				id: "starts_at",
			},
			{
				accessorKey: "expires_at",
				cell: ({ row }) => formatDate(row.original.expires_at) || t`no expiry`,
				header: t`Expires`,
				id: "expires_at",
			},
			{
				accessorKey: "notes",
				cell: ({ row }) => (
					<Text size="xs" c="dimmed" lineClamp={1} maw={220}>
						{row.original.notes ?? ""}
					</Text>
				),
				header: t`Notes`,
				id: "notes",
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

type WorkspaceRequestRequester = {
	id: string;
	display_name: string | null;
	email: string | null;
};

type WorkspaceRequestRow = {
	id: string;
	kind: string;
	status: string;
	requester: WorkspaceRequestRequester | null;
	org_id: string;
	org_name: string | null;
	workspace_id: string | null;
	workspace_name: string | null;
	proposed_name: string | null;
	proposed_tier: string;
	proposed_visibility: string | null;
	requester_message: string | null;
	granted_tier: string | null;
	granted_tier_expires_at: string | null;
	granted_type_discount: string | null;
	granted_percent_discount: number | null;
	resulting_workspace_id: string | null;
	decided_at: string | null;
	decided_by: WorkspaceRequestRequester | null;
	denial_reason: string | null;
	staff_notes: string | null;
	created_at: string | null;
};

type WorkspaceRequestListResponse = {
	items: WorkspaceRequestRow[];
	counts: Record<string, number>;
};

const kindLabels: Record<string, string> = {
	new_workspace: "New workspace",
	tier_upgrade: "Tier upgrade",
};

const visibilityLabels: Record<string, string> = {
	open_to_organisation: "Open to organisation",
	private: "Private",
};

async function patchWorkspaceRequest(
	requestId: string,
	body: Record<string, unknown>,
): Promise<{ id: string; status: string; resulting_workspace_id?: string }> {
	const res = await fetch(
		`${API_BASE_URL}/v2/admin/workspace-requests/${requestId}`,
		{
			body: JSON.stringify(body),
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			method: "PATCH",
		},
	);
	if (!res.ok) {
		const err = await res.json().catch(() => ({}));
		throw new Error(err.detail || `Request failed (${res.status})`);
	}
	return res.json();
}

function ApproveDialog({
	request: req,
	opened,
	onClose,
	onSuccess,
}: {
	request: WorkspaceRequestRow;
	opened: boolean;
	onClose: () => void;
	onSuccess: () => void;
}) {
	const queryClient = useQueryClient();
	const [grantedTier, setGrantedTier] = useState<string>(req.proposed_tier);
	const [typeDiscount, setTypeDiscount] = useState<string | null>(null);
	const [percentDiscount, setPercentDiscount] = useState<number | string>("");
	const [staffNotes, setStaffNotes] = useState("");

	const mutation = useMutation({
		mutationFn: () =>
			patchWorkspaceRequest(req.id, {
				action: "approve",
				granted_percent_discount:
					percentDiscount !== "" ? Number(percentDiscount) : undefined,
				granted_tier: grantedTier,
				granted_type_discount: typeDiscount || undefined,
				staff_notes: staffNotes || undefined,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["v2", "admin", "workspace-requests"],
			});
			onSuccess();
		},
	});

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={t`Approve request`}
			size="xl"
		>
			<Stack gap="md">
				<Text size="sm">
					<Trans>
						Approving request from {req.requester?.display_name ?? "unknown"}{" "}
						for a {kindLabels[req.kind]} ({req.proposed_tier}).
					</Trans>
				</Text>

				<TierPricingCards
					value={grantedTier}
					onChange={(v) => setGrantedTier(v)}
				/>

				<Select
					label={t`Discount type (optional)`}
					data={[
						{ label: "Scholarship", value: "scholarship" },
						{ label: "Staff discount", value: "staff_discount" },
					]}
					value={typeDiscount}
					onChange={setTypeDiscount}
					clearable
				/>

				<NumberInput
					label={t`Discount % (optional)`}
					min={0}
					max={100}
					value={percentDiscount}
					onChange={setPercentDiscount}
				/>

				<Textarea
					label={t`Staff notes (internal, optional)`}
					value={staffNotes}
					onChange={(e) => setStaffNotes(e.currentTarget.value)}
					maxLength={2000}
					autosize
					minRows={2}
				/>

				{mutation.isError && (
					<Text size="xs" c="red">
						{(mutation.error as Error).message}
					</Text>
				)}

				<Group justify="flex-end">
					<Button variant="subtle" onClick={onClose}>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						color="primary"
						loading={mutation.isPending}
						onClick={() => mutation.mutate()}
					>
						<Trans>Approve</Trans>
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}

function DenyDialog({
	request: req,
	opened,
	onClose,
	onSuccess,
}: {
	request: WorkspaceRequestRow;
	opened: boolean;
	onClose: () => void;
	onSuccess: () => void;
}) {
	const queryClient = useQueryClient();
	const [reason, setReason] = useState("");
	const [staffNotes, setStaffNotes] = useState("");

	const mutation = useMutation({
		mutationFn: () =>
			patchWorkspaceRequest(req.id, {
				action: "deny",
				denial_reason: reason,
				staff_notes: staffNotes || undefined,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["v2", "admin", "workspace-requests"],
			});
			onSuccess();
		},
	});

	return (
		<Modal opened={opened} onClose={onClose} title={t`Deny request`} size="md">
			<Stack gap="md">
				<Text size="sm">
					<Trans>
						Denying request from {req.requester?.display_name ?? "unknown"} for
						a {kindLabels[req.kind]} ({req.proposed_tier}).
					</Trans>
				</Text>

				<Textarea
					label={t`Denial reason (required)`}
					value={reason}
					onChange={(e) => setReason(e.currentTarget.value)}
					maxLength={2000}
					autosize
					minRows={3}
					required
				/>

				<Textarea
					label={t`Staff notes (internal, optional)`}
					value={staffNotes}
					onChange={(e) => setStaffNotes(e.currentTarget.value)}
					maxLength={2000}
					autosize
					minRows={2}
				/>

				{mutation.isError && (
					<Text size="xs" c="red">
						{(mutation.error as Error).message}
					</Text>
				)}

				<Group justify="flex-end">
					<Button variant="subtle" onClick={onClose}>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						color="red"
						loading={mutation.isPending}
						onClick={() => mutation.mutate()}
						disabled={!reason.trim()}
					>
						<Trans>Deny</Trans>
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}

function WorkspaceRequestDetail({
	request: req,
	onClose,
}: {
	request: WorkspaceRequestRow;
	onClose: () => void;
}) {
	const stack = useModalsStack(["approve-dialog", "deny-dialog"]);
	const showDetail =
		!stack.state["approve-dialog"] && !stack.state["deny-dialog"];

	const handleActionSuccess = () => {
		stack.closeAll();
		onClose();
	};

	return (
		<>
			<Modal
				opened={showDetail}
				onClose={onClose}
				title={
					<Group gap="xs">
						<Text fw={500}>{kindLabels[req.kind] ?? req.kind}</Text>
						<Badge
							size="xs"
							color={
								req.status === "pending"
									? "yellow"
									: req.status === "approved"
										? "primary"
										: "red"
							}
							variant="light"
							tt="capitalize"
						>
							{req.status}
						</Badge>
					</Group>
				}
				size="lg"
			>
				<Stack gap="md">
					<Divider label={t`Requester`} labelPosition="left" />
					<SimpleGrid cols={2}>
						<Box>
							<Text size="xs" c="dimmed">
								<Trans>Requester</Trans>
							</Text>
							<Text size="sm">
								{req.requester?.display_name ?? req.requester?.id ?? "-"}
							</Text>
							{req.requester?.email && (
								<Text size="xs" c="dimmed">
									{req.requester.email}
								</Text>
							)}
						</Box>
						<Box>
							<Text size="xs" c="dimmed">
								<Trans>Organisation</Trans>
							</Text>
							<Text size="sm">{req.org_name ?? req.org_id}</Text>
						</Box>
						<Box>
							<Text size="xs" c="dimmed">
								<Trans>Submitted</Trans>
							</Text>
							<Text size="sm">{formatDate(req.created_at)}</Text>
						</Box>
						<Box>
							<Text size="xs" c="dimmed">
								<Trans>Kind</Trans>
							</Text>
							<Text size="sm">{kindLabels[req.kind] ?? req.kind}</Text>
						</Box>
					</SimpleGrid>

					<Divider label={t`Proposed`} labelPosition="left" />
					<SimpleGrid cols={2}>
						{req.proposed_name && (
							<Box>
								<Text size="xs" c="dimmed">
									<Trans>Workspace name</Trans>
								</Text>
								<Text size="sm">{req.proposed_name}</Text>
							</Box>
						)}
						<Box>
							<Text size="xs" c="dimmed">
								<Trans>Proposed tier</Trans>
							</Text>
							<Badge
								size="sm"
								color={tierColors[req.proposed_tier] ?? "gray"}
								variant="filled"
								tt="capitalize"
							>
								{req.proposed_tier}
							</Badge>
						</Box>
						{req.proposed_visibility && (
							<Box>
								<Text size="xs" c="dimmed">
									<Trans>Visibility</Trans>
								</Text>
								<Text size="sm">
									{visibilityLabels[req.proposed_visibility] ??
										req.proposed_visibility}
								</Text>
							</Box>
						)}
						{req.workspace_id && (
							<Box>
								<Text size="xs" c="dimmed">
									<Trans>Target workspace</Trans>
								</Text>
								<Anchor
									component={I18nLink}
									to={`/w/${req.workspace_id}/settings`}
									size="sm"
								>
									{req.workspace_name ?? req.workspace_id}
								</Anchor>
							</Box>
						)}
					</SimpleGrid>

					{req.requester_message && (
						<>
							<Divider label={t`Message`} labelPosition="left" />
							<Paper withBorder p="sm" radius="sm">
								<Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
									{req.requester_message}
								</Text>
							</Paper>
						</>
					)}

					{req.status !== "pending" && (
						<>
							<Divider label={t`Decision`} labelPosition="left" />
							<SimpleGrid cols={2}>
								<Box>
									<Text size="xs" c="dimmed">
										<Trans>Decided at</Trans>
									</Text>
									<Text size="sm">{formatDate(req.decided_at)}</Text>
								</Box>
								<Box>
									<Text size="xs" c="dimmed">
										<Trans>Decided by</Trans>
									</Text>
									<Text size="sm">
										{req.decided_by?.display_name ?? req.decided_by?.id ?? "-"}
									</Text>
								</Box>
								{req.granted_tier && (
									<Box>
										<Text size="xs" c="dimmed">
											<Trans>Granted tier</Trans>
										</Text>
										<Badge
											size="sm"
											color={tierColors[req.granted_tier] ?? "gray"}
											variant="filled"
											tt="capitalize"
										>
											{req.granted_tier}
										</Badge>
									</Box>
								)}
								{req.granted_tier_expires_at && (
									<Box>
										<Text size="xs" c="dimmed">
											<Trans>Tier expires</Trans>
										</Text>
										<Text size="sm">
											{formatDate(req.granted_tier_expires_at)}
										</Text>
									</Box>
								)}
								{req.granted_type_discount && (
									<Box>
										<Text size="xs" c="dimmed">
											<Trans>Discount type</Trans>
										</Text>
										<Badge size="sm" variant="light" tt="capitalize">
											{req.granted_type_discount.replace(/_/g, " ")}
										</Badge>
									</Box>
								)}
								{req.granted_percent_discount != null && (
									<Box>
										<Text size="xs" c="dimmed">
											<Trans>Discount %</Trans>
										</Text>
										<Text size="sm">{req.granted_percent_discount}%</Text>
									</Box>
								)}
								{req.denial_reason && (
									<Box style={{ gridColumn: "1 / -1" }}>
										<Text size="xs" c="dimmed">
											<Trans>Denial reason</Trans>
										</Text>
										<Paper withBorder p="xs" radius="sm" mt={4}>
											<Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
												{req.denial_reason}
											</Text>
										</Paper>
									</Box>
								)}
								{req.resulting_workspace_id && (
									<Box>
										<Text size="xs" c="dimmed">
											<Trans>Resulting workspace</Trans>
										</Text>
										<Anchor
											component={I18nLink}
											to={`/w/${req.resulting_workspace_id}/settings`}
											size="sm"
										>
											<Trans>View workspace</Trans>
										</Anchor>
									</Box>
								)}
							</SimpleGrid>
						</>
					)}

					{req.staff_notes && (
						<>
							<Divider label={t`Staff notes`} labelPosition="left" />
							<Paper withBorder p="sm" radius="sm" bg="gray.0">
								<Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
									{req.staff_notes}
								</Text>
							</Paper>
						</>
					)}

					{req.status === "pending" && (
						<>
							<Divider />
							<Group justify="flex-end">
								<Button
									variant="subtle"
									color="red"
									onClick={() => stack.open("deny-dialog")}
								>
									<Trans>Deny</Trans>
								</Button>
								<Button
									color="primary"
									onClick={() => stack.open("approve-dialog")}
								>
									<Trans>Approve</Trans>
								</Button>
							</Group>
						</>
					)}
				</Stack>
			</Modal>

			<ApproveDialog
				request={req}
				opened={stack.state["approve-dialog"]}
				onClose={() => stack.close("approve-dialog")}
				onSuccess={handleActionSuccess}
			/>
			<DenyDialog
				request={req}
				opened={stack.state["deny-dialog"]}
				onClose={() => stack.close("deny-dialog")}
				onSuccess={handleActionSuccess}
			/>
		</>
	);
}

function UpgradesPanel() {
	const [statusFilter, setStatusFilter] = useState<string>("pending");
	const [selectedRequest, setSelectedRequest] =
		useState<WorkspaceRequestRow | null>(null);
	const { data, isLoading } = useQuery({
		queryFn: () =>
			fetchJson<WorkspaceRequestListResponse>(
				`/v2/admin/workspace-requests?status=${statusFilter}`,
			),
		queryKey: ["v2", "admin", "workspace-requests", statusFilter],
		staleTime: 30_000,
	});
	const [globalFilter, setGlobalFilter] = useState("");

	const columns = useMemo<ColumnDef<WorkspaceRequestRow, unknown>[]>(
		() => [
			{
				accessorKey: "kind",
				cell: ({ row }) => (
					<Badge
						size="xs"
						variant="light"
						color={row.original.kind === "new_workspace" ? "primary" : "violet"}
					>
						{kindLabels[row.original.kind] ?? row.original.kind}
					</Badge>
				),
				header: t`Kind`,
				id: "kind",
			},
			{
				accessorFn: (r) =>
					r.requester?.display_name ?? r.requester?.email ?? "",
				cell: ({ row }) => (
					<Text size="xs" fw={500}>
						{row.original.requester?.display_name ?? "-"}
					</Text>
				),
				header: t`Requester`,
				id: "requester",
			},
			{
				accessorFn: (r) => r.org_name ?? "",
				cell: ({ row }) => (
					<Text size="xs" c="dimmed">
						{row.original.org_name ?? "-"}
					</Text>
				),
				header: t`Organisation`,
				id: "org_name",
			},
			{
				accessorKey: "proposed_tier",
				cell: ({ row }) => (
					<Badge
						size="xs"
						color={tierColors[row.original.proposed_tier] ?? "gray"}
						variant="filled"
						tt="capitalize"
					>
						{row.original.proposed_tier}
					</Badge>
				),
				header: t`Proposed tier`,
				id: "proposed_tier",
				sortingFn: (a, b) =>
					tierRank(a.original.proposed_tier) -
					tierRank(b.original.proposed_tier),
			},
			{
				accessorFn: (r) => r.requester_message ?? "",
				cell: ({ row }) => (
					<Text size="xs" c="dimmed" lineClamp={1} maw={200}>
						{row.original.requester_message ?? "-"}
					</Text>
				),
				header: t`Message`,
				id: "message",
			},
			{
				accessorKey: "created_at",
				cell: ({ row }) => (
					<Tooltip
						label={formatDate(row.original.created_at)}
						withArrow
						position="top"
					>
						<Text size="sm" c="dimmed">
							{row.original.created_at
								? formatDistance(
										new Date(row.original.created_at),
										new Date(),
										{ addSuffix: true },
									)
								: "-"}
						</Text>
					</Tooltip>
				),
				header: t`Submitted`,
				id: "created_at",
			},
			{
				cell: ({ row }) => (
					<Button
						size="compact-xs"
						variant="outline"
						leftSection={<IconEye size={14} />}
						onClick={(e) => {
							e.stopPropagation();
							setSelectedRequest(row.original);
						}}
					>
						<Trans>Open details</Trans>
					</Button>
				),
				header: "",
				id: "actions",
			},
		],
		[],
	);

	const items = data?.items ?? [];
	const counts = data?.counts ?? { approved: 0, denied: 0, pending: 0 };

	return (
		<Stack gap="sm">
			<Tabs
				value={statusFilter}
				onChange={(v) => {
					if (v) {
						setStatusFilter(v);
						setGlobalFilter("");
					}
				}}
			>
				<Tabs.List>
					<Tabs.Tab value="pending">
						<Group gap={6}>
							<Trans>Pending</Trans>
							<Badge size="xs" variant="filled" color="yellow" circle>
								{counts.pending}
							</Badge>
						</Group>
					</Tabs.Tab>
					<Tabs.Tab value="approved">
						<Group gap={6}>
							<Trans>Approved</Trans>
							<Badge size="xs" variant="filled" color="primary" circle>
								{counts.approved}
							</Badge>
						</Group>
					</Tabs.Tab>
					<Tabs.Tab value="denied">
						<Group gap={6}>
							<Trans>Denied</Trans>
							<Badge size="xs" variant="filled" color="red" circle>
								{counts.denied}
							</Badge>
						</Group>
					</Tabs.Tab>
				</Tabs.List>
			</Tabs>

			{isLoading ? (
				<Center py="xl">
					<Loader size="sm" color="gray" />
				</Center>
			) : (
				<>
					<Group justify="space-between" align="center" wrap="wrap">
						<Text size="xs" c="dimmed">
							<Plural value={items.length} one="# request" other="# requests" />
						</Text>
						<TextInput
							leftSection={<IconSearch size={14} />}
							placeholder={t`Search requester, organisation, tier`}
							value={globalFilter}
							onChange={(e) => setGlobalFilter(e.currentTarget.value)}
							size="xs"
							style={{ maxWidth: 320 }}
						/>
					</Group>
					<Paper withBorder radius="sm" style={{ overflowX: "auto" }}>
						<Table highlightOnHover verticalSpacing="sm" fz="sm">
							<Table.Thead>
								<Table.Tr>
									{columns.map((col) => (
										<Table.Th key={col.id}>
											<Text
												size="xs"
												fw={500}
												c="dimmed"
												tt="uppercase"
												lts={0.3}
											>
												{typeof col.header === "string" ? col.header : ""}
											</Text>
										</Table.Th>
									))}
								</Table.Tr>
							</Table.Thead>
							<Table.Tbody>
								{items.length === 0 ? (
									<Table.Tr>
										<Table.Td colSpan={columns.length}>
											<Text size="xs" c="dimmed" ta="center" py="md">
												{statusFilter === "pending"
													? t`No pending requests.`
													: statusFilter === "approved"
														? t`No approved requests.`
														: t`No denied requests.`}
											</Text>
										</Table.Td>
									</Table.Tr>
								) : (
									items
										.filter((item) => {
											if (!globalFilter) return true;
											const q = globalFilter.toLowerCase();
											return (
												(item.requester?.display_name ?? "")
													.toLowerCase()
													.includes(q) ||
												(item.requester?.email ?? "")
													.toLowerCase()
													.includes(q) ||
												(item.org_name ?? "").toLowerCase().includes(q) ||
												(item.proposed_tier ?? "").toLowerCase().includes(q) ||
												(item.proposed_name ?? "").toLowerCase().includes(q) ||
												(item.requester_message ?? "").toLowerCase().includes(q)
											);
										})
										.map((item) => (
											<Table.Tr
												key={item.id}
												style={{ cursor: "pointer" }}
												onClick={() => setSelectedRequest(item)}
											>
												<Table.Td>
													<Badge
														size="xs"
														variant="light"
														color={
															item.kind === "new_workspace"
																? "primary"
																: "violet"
														}
													>
														{kindLabels[item.kind] ?? item.kind}
													</Badge>
												</Table.Td>
												<Table.Td>
													<Text size="sm" fw={500}>
														{item.requester?.display_name ?? "-"}
													</Text>
												</Table.Td>
												<Table.Td>
													<Text size="sm" c="dimmed">
														{item.org_name ?? "-"}
													</Text>
												</Table.Td>
												<Table.Td>
													<Badge
														size="xs"
														color={tierColors[item.proposed_tier] ?? "gray"}
														variant="filled"
														tt="capitalize"
													>
														{item.proposed_tier}
													</Badge>
												</Table.Td>
												<Table.Td>
													<Text size="sm" c="dimmed" lineClamp={1} maw={200}>
														{item.requester_message ?? "-"}
													</Text>
												</Table.Td>
												<Table.Td>
													<Tooltip
														label={formatDate(item.created_at)}
														withArrow
														position="top"
													>
														<Text size="sm" c="dimmed">
															{item.created_at
																? formatDistance(
																		new Date(item.created_at),
																		new Date(),
																		{ addSuffix: true },
																	)
																: "-"}
														</Text>
													</Tooltip>
												</Table.Td>
												<Table.Td>
													<Button
														size="compact-xs"
														variant="outline"
														leftSection={<IconEye size={14} />}
														onClick={(e) => {
															e.stopPropagation();
															setSelectedRequest(item);
														}}
													>
														<Trans>Open details</Trans>
													</Button>
												</Table.Td>
											</Table.Tr>
										))
								)}
							</Table.Tbody>
						</Table>
					</Paper>
				</>
			)}

			{selectedRequest && (
				<WorkspaceRequestDetail
					request={selectedRequest}
					onClose={() => setSelectedRequest(null)}
				/>
			)}
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
