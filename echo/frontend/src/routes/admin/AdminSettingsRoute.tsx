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
	TextInput,
	Title,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { useDisclosure, useDocumentTitle } from "@mantine/hooks";
import {
	IconAdjustments,
	IconArrowsSort,
	IconChevronDown,
	IconChevronRight,
	IconDots,
	IconDownload,
	IconExternalLink,
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
	type SortingState,
	useReactTable,
	type VisibilityState,
} from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { ConfirmModal } from "@/components/common/ConfirmModal";
import { I18nLink } from "@/components/common/i18nLink";
import { toast } from "@/components/common/Toaster";
import { UsageFreshness } from "@/components/common/UsageFreshness";
import { API_BASE_URL } from "@/config";
import { useV2Me } from "@/hooks/useV2Me";
import { type BillingPeriod, TIER_ORDER, type Tier } from "@/lib/tiers";
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
	billing_account_id: string | null;
	account_scope: "organisation" | "workspace" | null;
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
	external_count: number;
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
	billing_period: BillingPeriod | null;
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
 * Live staff action: grant a comped one-month Changemaker reverse trial on the
 * row's billing account. Auto-reverts to Free at expiry (expiry cron).
 */
function GrantTrialControl({ accountId }: { accountId: string }) {
	const queryClient = useQueryClient();
	const mutation = useMutation({
		mutationFn: async () => {
			const res = await fetch(
				`${API_BASE_URL}/v2/admin/billing-accounts/${accountId}/grant-trial`,
				{
					body: JSON.stringify({ months: 1, tier: "changemaker" }),
					credentials: "include",
					headers: { "Content-Type": "application/json" },
					method: "POST",
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
			<Group justify="space-between" wrap="nowrap" align="center">
				<Stack gap={0} style={{ minWidth: 0 }}>
					<Text size="sm" fw={500}>
						<Trans>Grant Changemaker trial</Trans>
					</Text>
					<Text size="xs" c="dimmed">
						<Trans>
							One month of Changemaker on this account, comped. Auto-reverts to
							Free at expiry.
						</Trans>
					</Text>
					{mutation.isError && (
						<Text size="xs" c="red">
							{(mutation.error as Error).message}
						</Text>
					)}
					{mutation.isSuccess && (
						<Text size="xs" c="primary">
							<Trans>Trial granted</Trans>
						</Text>
					)}
				</Stack>
				<Button
					size="xs"
					variant="light"
					loading={mutation.isPending}
					onClick={() => mutation.mutate()}
				>
					<Trans>Grant</Trans>
				</Button>
			</Group>
		</Paper>
	);
}

/**
 * Account-scope label for a workspace row. An org-scoped billing account is
 * the org's shared account ("Organisation account"); a workspace-scoped one is
 * billed on its own ("Workspace account").
 */
function accountScopeLabel(scope: BillingRow["account_scope"]): string {
	if (scope === "organisation") return t`Organisation account`;
	if (scope === "workspace") return t`Workspace account`;
	return t`Account`;
}

/**
 * Staff action: change a workspace's tier. Reuses the existing staff endpoint
 * PATCH /v2/workspaces/{id}/tier (downgrade effects + notifications live
 * there). Confirms before applying because a downgrade strips features.
 */
function ChangeTierControl({ row }: { row: BillingRow }) {
	const queryClient = useQueryClient();
	const [tier, setTier] = useState<string | null>(row.tier);
	const [confirmOpen, { open: openConfirm, close: closeConfirm }] =
		useDisclosure(false);

	const mutation = useMutation({
		mutationFn: async () => {
			const res = await fetch(
				`${API_BASE_URL}/v2/workspaces/${row.workspace_id}/tier`,
				{
					body: JSON.stringify({ reason: "Staff dashboard tier change", tier }),
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
		onError: (e) => {
			closeConfirm();
			toast.error((e as Error).message);
		},
		onSuccess: () => {
			closeConfirm();
			toast.success(t`Tier changed`);
			queryClient.invalidateQueries({
				queryKey: ["v2", "admin", "billing-rollup"],
			});
		},
	});

	// pilot is staff-only legacy; offer the live per-seat tiers.
	const tierData = TIER_ORDER.map((value) => ({
		label: value.charAt(0).toUpperCase() + value.slice(1),
		value,
	}));

	return (
		<Paper withBorder radius="sm" p="sm">
			<Stack gap="xs">
				<Text size="sm" fw={500}>
					<Trans>Change tier</Trans>
				</Text>
				<Text size="xs" c="dimmed">
					<Trans>
						A downgrade applies the matrix downgrade effects and notifies
						workspace admins.
					</Trans>
				</Text>
				<Group gap="xs" align="flex-end">
					<Select
						data={tierData}
						value={tier}
						onChange={setTier}
						size="xs"
						style={{ flex: 1 }}
						aria-label={t`New tier`}
					/>
					<Button
						size="xs"
						variant="light"
						disabled={!tier || tier === row.tier}
						loading={mutation.isPending}
						onClick={openConfirm}
					>
						<Trans>Apply</Trans>
					</Button>
				</Group>
			</Stack>
			<ConfirmModal
				opened={confirmOpen}
				onClose={closeConfirm}
				onConfirm={() => mutation.mutate()}
				loading={mutation.isPending}
				title={t`Change tier`}
				data-testid="admin-change-tier-modal"
				confirmLabel={<Trans>Change tier</Trans>}
				message={
					<Trans>
						Move {row.workspace_name} from {row.tier} to {tier}? A downgrade
						limits features immediately.
					</Trans>
				}
			/>
		</Paper>
	);
}

/**
 * Staff action: promote a workspace member to admin. Used when the current
 * admin is unreachable; never demotes anyone, so an admin always remains.
 */
function ChangeAdminControl({ row }: { row: BillingRow }) {
	const queryClient = useQueryClient();
	const [membershipId, setMembershipId] = useState<string | null>(null);
	const [confirmOpen, { open: openConfirm, close: closeConfirm }] =
		useDisclosure(false);

	const { data: members, isLoading } = useQuery({
		queryFn: () =>
			fetchJson<
				{
					membership_id: string;
					display_name: string | null;
					email: string | null;
					role: string | null;
				}[]
			>(`/v2/admin/workspaces/${row.workspace_id}/members`),
		queryKey: ["v2", "admin", "workspace-members", row.workspace_id],
		staleTime: 30_000,
	});

	const mutation = useMutation({
		mutationFn: async () => {
			const res = await fetch(
				`${API_BASE_URL}/v2/admin/workspaces/${row.workspace_id}/change-admin`,
				{
					body: JSON.stringify({ membership_id: membershipId }),
					credentials: "include",
					headers: { "Content-Type": "application/json" },
					method: "POST",
				},
			);
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				throw new Error(err.detail || `Failed (${res.status})`);
			}
			return res.json();
		},
		onError: (e) => {
			closeConfirm();
			toast.error((e as Error).message);
		},
		onSuccess: () => {
			closeConfirm();
			toast.success(t`Workspace admin changed`);
			queryClient.invalidateQueries({
				queryKey: ["v2", "admin", "billing-rollup"],
			});
			queryClient.invalidateQueries({
				queryKey: ["v2", "admin", "workspace-members", row.workspace_id],
			});
		},
	});

	const memberData = (members ?? [])
		.filter((m) => m.role !== "external")
		.map((m) => ({
			label: `${m.display_name ?? m.email ?? m.membership_id.slice(0, 8)}${
				m.role === "admin" || m.role === "owner" ? ` (${m.role})` : ""
			}`,
			value: m.membership_id,
		}));
	const selected = members?.find((m) => m.membership_id === membershipId);

	return (
		<Paper withBorder radius="sm" p="sm">
			<Stack gap="xs">
				<Text size="sm" fw={500}>
					<Trans>Change workspace admin</Trans>
				</Text>
				<Text size="xs" c="dimmed">
					<Trans>
						Promote a member to admin. Existing admins keep their role.
					</Trans>
				</Text>
				<Group gap="xs" align="flex-end">
					<Select
						data={memberData}
						value={membershipId}
						onChange={setMembershipId}
						placeholder={isLoading ? t`Loading members` : t`Pick a member`}
						searchable
						size="xs"
						style={{ flex: 1 }}
						aria-label={t`Member to promote`}
					/>
					<Button
						size="xs"
						variant="light"
						disabled={!membershipId}
						loading={mutation.isPending}
						onClick={openConfirm}
					>
						<Trans>Promote</Trans>
					</Button>
				</Group>
			</Stack>
			<ConfirmModal
				opened={confirmOpen}
				onClose={closeConfirm}
				onConfirm={() => mutation.mutate()}
				loading={mutation.isPending}
				title={t`Change workspace admin`}
				data-testid="admin-change-admin-modal"
				confirmLabel={<Trans>Promote to admin</Trans>}
				message={
					<Trans>
						Promote{" "}
						{selected?.display_name ?? selected?.email ?? t`this member`} to
						admin of {row.workspace_name}?
					</Trans>
				}
			/>
		</Paper>
	);
}

/**
 * Staff action: reset this cycle's recorded audio hours. Stamps a
 * usage_reset_at floor (conversations are not deleted). Confirms first; the
 * reason is recorded for the audit trail.
 */
function ResetUsageControl({ row }: { row: BillingRow }) {
	const queryClient = useQueryClient();
	const [reason, setReason] = useState("");
	const [confirmOpen, { open: openConfirm, close: closeConfirm }] =
		useDisclosure(false);

	const mutation = useMutation({
		mutationFn: async () => {
			const res = await fetch(
				`${API_BASE_URL}/v2/admin/workspaces/${row.workspace_id}/reset-usage`,
				{
					body: JSON.stringify({ reason: reason.trim() }),
					credentials: "include",
					headers: { "Content-Type": "application/json" },
					method: "POST",
				},
			);
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				throw new Error(err.detail || `Failed (${res.status})`);
			}
			return res.json();
		},
		onError: (e) => {
			closeConfirm();
			toast.error((e as Error).message);
		},
		onSuccess: () => {
			closeConfirm();
			toast.success(t`Monthly usage reset`);
			queryClient.invalidateQueries({
				queryKey: ["v2", "admin", "billing-rollup"],
			});
		},
	});

	return (
		<Paper withBorder radius="sm" p="sm">
			<Stack gap="xs">
				<Text size="sm" fw={500}>
					<Trans>Reset monthly usage</Trans>
				</Text>
				<Text size="xs" c="dimmed">
					<Trans>
						Zeroes this cycle's recorded hours from now on. Conversations are
						kept; only the billing count resets.
					</Trans>
				</Text>
				<TextInput
					label={t`Reason`}
					placeholder={t`Support incident, double-counted upload, etc.`}
					value={reason}
					onChange={(e) => setReason(e.currentTarget.value)}
					size="xs"
				/>
				<Group justify="flex-end">
					<Button
						size="xs"
						variant="light"
						color="red"
						disabled={reason.trim().length === 0}
						loading={mutation.isPending}
						onClick={openConfirm}
					>
						<Trans>Reset usage</Trans>
					</Button>
				</Group>
			</Stack>
			<ConfirmModal
				opened={confirmOpen}
				onClose={closeConfirm}
				onConfirm={() => mutation.mutate()}
				loading={mutation.isPending}
				confirmColor="red"
				title={t`Reset monthly usage`}
				data-testid="admin-reset-usage-modal"
				confirmLabel={<Trans>Reset usage</Trans>}
				message={
					<Trans>
						Reset this cycle's recorded hours for {row.workspace_name}? This is
						recorded in the audit trail.
					</Trans>
				}
			/>
		</Paper>
	);
}

/**
 * Actions modal for a workspace row. Live staff edits (discount, trial, change
 * tier, change admin, reset usage). Transfer-to-partner and delete-workspace
 * stay disabled (destructive, deferred to their own issues).
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
	const deferredActions: { label: string; hint: string; color?: string }[] = [
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
					<Badge size="xs" color="gray" variant="outline">
						{accountScopeLabel(row.account_scope)}
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

				{row.billing_account_id && (
					<GrantTrialControl accountId={row.billing_account_id} />
				)}

				<ChangeTierControl row={row} />
				<ChangeAdminControl row={row} />
				<ResetUsageControl row={row} />

				<Divider my={4} />
				{deferredActions.map((a) => (
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
							<Tooltip label={t`Deferred to its own reviewed issue`} withArrow>
								<Button
									size="xs"
									variant="outline"
									color={a.color ?? "gray"}
									disabled
								>
									<Trans>Run</Trans>
								</Button>
							</Tooltip>
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
		total_forecast_eur: number;
	};
}) {
	// useReactTable returns a stable ref; React Compiler caches our JSX on
	// it, so state changes never reach the DOM. See frontend/AGENTS.md.
	"use no memo";
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
									seat_count: (
										<Text size="xs" fw={600} ta="right">
											{footerTotals.seat_count}
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
			{ count: number; base: number; active: number }
		>();
		for (const tier of TIER_ORDER) {
			groups.set(tier, { active: 0, base: 0, count: 0 });
		}
		for (const r of rows) {
			const g = groups.get(r.tier) ?? {
				active: 0,
				base: 0,
				count: 0,
			};
			g.count += 1;
			g.base += r.base_price_eur ?? 0;
			if (r.is_active) g.active += 1;
			groups.set(r.tier, g);
		}
		return TIER_ORDER.map((tier) => ({
			tier,
			...(groups.get(tier) ?? { active: 0, base: 0, count: 0 }),
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
			if (statusFilter === "active" && !r.is_active) return false;
			if (statusFilter === "inactive" && r.is_active) return false;
			if (tierFilter.length > 0 && !tierFilter.includes(r.tier)) return false;
			return true;
		});
	}, [data, statusFilter, tierFilter]);

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
				accessorFn: (r) => r.billing_period ?? "",
				cell: ({ row }) => {
					const bp = row.original.billing_period;
					if (!bp) {
						return (
							<Text size="xs" c="dimmed">
								—
							</Text>
						);
					}
					return (
						<Badge
							size="xs"
							variant="light"
							color={bp === "annual" ? "blue" : "gray"}
							tt="capitalize"
						>
							{bp}
						</Badge>
					);
				},
				header: t`Billing`,
				id: "billing_period",
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
				accessorFn: (r) => r.seat_count + r.external_count,
				cell: ({ row }) => (
					<UsageBar
						used={row.original.seat_count + row.original.external_count}
						cap={row.original.seats_included}
					/>
				),
				header: t`Seats`,
				id: "seat_count",
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
			seat_count: prefiltered.reduce(
				(s, r) => s + r.seat_count + r.external_count,
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
			"organisation",
			"account_scope",
			"tier",
			"tier_expires_at",
			"type_discount",
			"percent_discount",
			"audio_hours",
			"audio_hours_included",
			"seat_count",
			"seats_included",
			"external_count",
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
				r.account_scope ?? "",
				r.tier,
				r.tier_expires_at ?? "",
				r.type_discount ?? "",
				r.percent_discount ?? "",
				r.audio_hours.toFixed(2),
				r.audio_hours_included ?? "",
				r.seat_count,
				r.seats_included ?? "",
				r.external_count,
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
	// See BillingTable / frontend/AGENTS.md for the rationale.
	"use no memo";
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

type PaymentRow = {
	payment_id: string;
	billing_account_id: string | null;
	account_label: string | null;
	org_id: string | null;
	org_name: string | null;
	tier: string | null;
	created_at: string | null;
	amount: string | null;
	currency: string;
	status: string | null;
	sequence_type: string | null;
	method: string | null;
	description: string;
	dashboard_url: string | null;
};

type PaymentsRollup = {
	mollie_enabled: boolean;
	mollie_test_mode: boolean;
	mollie_dashboard_url: string;
	accounts_with_customer: number;
	payment_count: number;
	paid_eur: number;
	failed_count: number;
	open_count: number;
	rows: PaymentRow[];
};

// Mollie payment status to a brand-safe badge color. Paid is primary (Royal
// Blue), trouble states red, in-flight gray.
const paymentStatusColor = (status: string | null): string => {
	switch (status) {
		case "paid":
			return "primary";
		case "failed":
		case "expired":
		case "canceled":
			return "red";
		default:
			return "gray";
	}
};

const formatPaymentAmount = (
	amount: string | null,
	currency: string,
): string => {
	if (!amount) return "";
	const n = Number(amount);
	if (Number.isNaN(n)) return amount;
	const symbol = currency === "EUR" ? "€" : `${currency} `;
	return `${symbol}${n.toLocaleString(undefined, {
		maximumFractionDigits: 2,
		minimumFractionDigits: 2,
	})}`;
};

/**
 * Payments rollup (Wave B). Read-only view of recent Mollie transactions
 * pooled across every billing account, newest first, plus a deep link to the
 * Mollie dashboard. dembrane never auto-blocks for non-payment, so this is how
 * staff spot failed / overdue charges and decide who to chase.
 */
// Group payments by calendar month, newest month first, so the staff list
// reads as "this month / last month / ...". Returns an ordered list of
// { key, label, rows } the panel renders as a section per month.
const groupPaymentsByMonth = (
	rows: PaymentRow[],
): { key: string; label: string; rows: PaymentRow[] }[] => {
	const byMonth = new Map<string, PaymentRow[]>();
	for (const r of rows) {
		// Sort key is YYYY-MM (chronological as a string); missing dates bucket
		// under "unknown" which sorts last.
		const key = r.created_at ? r.created_at.slice(0, 7) : "unknown";
		const list = byMonth.get(key);
		if (list) {
			list.push(r);
		} else {
			byMonth.set(key, [r]);
		}
	}
	return [...byMonth.entries()]
		.sort((a, b) => (a[0] < b[0] ? 1 : -1))
		.map(([key, monthRows]) => ({
			key,
			label:
				key === "unknown"
					? t`Unknown date`
					: new Date(`${key}-01T00:00:00`).toLocaleDateString(undefined, {
							month: "long",
							year: "numeric",
						}),
			rows: monthRows,
		}));
};

type PaymentStatusFilter = "all" | "paid" | "failed" | "pending" | "open";

// Maps the filter chip to the Mollie statuses it covers. "failed" folds in
// expired + canceled (the same bucket the headline "Failed" counter uses).
const paymentMatchesStatus = (
	status: string | null,
	filter: PaymentStatusFilter,
): boolean => {
	if (filter === "all") return true;
	if (filter === "failed")
		return status === "failed" || status === "expired" || status === "canceled";
	return status === filter;
};

function PaymentsPanel() {
	const { data, isLoading } = useQuery({
		queryFn: () => fetchJson<PaymentsRollup>("/v2/admin/payments"),
		queryKey: ["v2", "admin", "payments"],
		staleTime: 60_000,
	});
	const [globalFilter, setGlobalFilter] = useState("");
	const [statusFilter, setStatusFilter] = useState<PaymentStatusFilter>("all");

	const columns = useMemo<ColumnDef<PaymentRow, unknown>[]>(
		() => [
			{
				accessorKey: "created_at",
				cell: ({ row }) => formatDate(row.original.created_at),
				header: t`Date`,
				id: "created_at",
			},
			{
				accessorFn: (r) => r.account_label ?? r.org_name ?? "",
				cell: ({ row }) =>
					row.original.org_id ? (
						<Anchor
							component={I18nLink}
							to={`/o/${row.original.org_id}`}
							size="xs"
							fw={500}
						>
							{row.original.account_label ??
								row.original.org_name ??
								row.original.billing_account_id?.slice(0, 8) ??
								"."}
						</Anchor>
					) : (
						<Text size="xs">
							{row.original.account_label ??
								row.original.billing_account_id?.slice(0, 8) ??
								"."}
						</Text>
					),
				header: t`Account`,
				id: "account",
			},
			{
				accessorKey: "tier",
				cell: ({ row }) =>
					row.original.tier ? (
						<Badge
							size="xs"
							color={tierColors[row.original.tier] ?? "gray"}
							variant="light"
							tt="capitalize"
						>
							{row.original.tier}
						</Badge>
					) : null,
				header: t`Tier`,
				id: "tier",
			},
			{
				accessorKey: "amount",
				cell: ({ row }) => (
					<Text size="xs" fw={500}>
						{formatPaymentAmount(row.original.amount, row.original.currency)}
					</Text>
				),
				header: t`Amount`,
				id: "amount",
				meta: { align: "right" },
			},
			{
				accessorKey: "status",
				cell: ({ row }) => (
					<Badge
						size="xs"
						color={paymentStatusColor(row.original.status)}
						variant="light"
						tt="capitalize"
					>
						{row.original.status ?? "."}
					</Badge>
				),
				header: t`Status`,
				id: "status",
			},
			{
				accessorKey: "sequence_type",
				cell: ({ row }) => {
					const seq = row.original.sequence_type;
					const label =
						seq === "first"
							? t`Initial`
							: seq === "recurring"
								? t`Renewal`
								: seq === "oneoff"
									? t`One-off`
									: (seq ?? "");
					return (
						<Text size="xs" c="dimmed">
							{label}
						</Text>
					);
				},
				header: t`Type`,
				id: "sequence_type",
			},
			{
				accessorKey: "description",
				cell: ({ row }) => (
					<Text size="xs" c="dimmed" lineClamp={1} maw={280}>
						{row.original.description}
					</Text>
				),
				header: t`Description`,
				id: "description",
			},
			{
				cell: ({ row }) =>
					row.original.dashboard_url ? (
						<Anchor
							href={row.original.dashboard_url}
							target="_blank"
							rel="noopener noreferrer"
							size="xs"
						>
							<Group gap={4} wrap="nowrap">
								<Trans>Open</Trans>
								<IconExternalLink size={12} />
							</Group>
						</Anchor>
					) : null,
				enableSorting: false,
				header: "",
				id: "dashboard",
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
	if (!data) {
		return (
			<Text c="red" size="sm">
				<Trans>Could not load payments. Check auth and backend logs.</Trans>
			</Text>
		);
	}

	const filteredRows = data.rows.filter((r) =>
		paymentMatchesStatus(r.status, statusFilter),
	);
	const monthGroups = groupPaymentsByMonth(filteredRows);

	const statusChips: { value: PaymentStatusFilter; label: string }[] = [
		{ label: t`All`, value: "all" },
		{ label: t`Paid`, value: "paid" },
		{ label: t`Failed`, value: "failed" },
		{ label: t`Pending`, value: "pending" },
		{ label: t`Open`, value: "open" },
	];

	return (
		<Stack gap="md">
			<Group justify="space-between" align="flex-end" wrap="wrap">
				<Stack gap={2}>
					<Group gap="xs" align="center">
						<Text size="sm" c="dimmed">
							<Trans>Recent payments across all accounts</Trans>
						</Text>
						{data.mollie_test_mode && (
							<Badge size="xs" color="gray" variant="light">
								<Trans>test mode</Trans>
							</Badge>
						)}
					</Group>
					<Text size="xs" c="dimmed">
						<Trans>
							No one is auto-blocked for non-payment. Watch failed charges here
							and follow up.
						</Trans>
					</Text>
				</Stack>
				<Button
					component="a"
					href={data.mollie_dashboard_url}
					target="_blank"
					rel="noopener noreferrer"
					size="xs"
					variant="outline"
					rightSection={<IconExternalLink size={14} />}
				>
					<Trans>Open Mollie dashboard</Trans>
				</Button>
			</Group>

			{!data.mollie_enabled && (
				<Paper withBorder radius="sm" p="sm">
					<Text size="xs" c="dimmed">
						<Trans>
							Mollie is not configured in this environment, so no live
							transactions are shown. The dashboard link still points to the
							right Mollie environment.
						</Trans>
					</Text>
				</Paper>
			)}

			<SimpleGrid cols={{ base: 2, sm: 4 }} spacing="sm">
				<Paper withBorder radius="sm" p="sm">
					<Stack gap={2}>
						<Text size="xs" c="dimmed">
							<Trans>Paid</Trans>
						</Text>
						<Text size="lg" fw={500}>
							{formatEur(data.paid_eur)}
						</Text>
					</Stack>
				</Paper>
				<Paper withBorder radius="sm" p="sm">
					<Stack gap={2}>
						<Text size="xs" c="dimmed">
							<Trans>Failed</Trans>
						</Text>
						<Text
							size="lg"
							fw={500}
							c={data.failed_count > 0 ? "red" : undefined}
						>
							{data.failed_count}
						</Text>
					</Stack>
				</Paper>
				<Paper withBorder radius="sm" p="sm">
					<Stack gap={2}>
						<Text size="xs" c="dimmed">
							<Trans>Pending</Trans>
						</Text>
						<Text size="lg" fw={500}>
							{data.open_count}
						</Text>
					</Stack>
				</Paper>
				<Paper withBorder radius="sm" p="sm">
					<Stack gap={2}>
						<Text size="xs" c="dimmed">
							<Trans>Accounts billed</Trans>
						</Text>
						<Text size="lg" fw={500}>
							{data.accounts_with_customer}
						</Text>
					</Stack>
				</Paper>
			</SimpleGrid>

			<Group justify="space-between" align="center" wrap="wrap">
				<Group gap="sm" wrap="wrap" align="center">
					<Text size="xs" c="dimmed">
						<Plural
							value={filteredRows.length}
							one="# payment"
							other="# payments"
						/>
					</Text>
					<Button.Group>
						{statusChips.map((chip) => (
							<Button
								key={chip.value}
								size="xs"
								variant={statusFilter === chip.value ? "filled" : "default"}
								color={statusFilter === chip.value ? "primary" : "gray"}
								onClick={() => setStatusFilter(chip.value)}
							>
								{chip.label}
							</Button>
						))}
					</Button.Group>
				</Group>
				<TextInput
					leftSection={<IconSearch size={14} />}
					placeholder={t`Search account, status, description`}
					value={globalFilter}
					onChange={(e) => setGlobalFilter(e.currentTarget.value)}
					size="xs"
					style={{ maxWidth: 320 }}
				/>
			</Group>

			{monthGroups.length === 0 ? (
				<Paper withBorder radius="sm" p="md">
					<Text size="xs" c="dimmed" ta="center">
						<Trans>No payments match the filter.</Trans>
					</Text>
				</Paper>
			) : (
				monthGroups.map((group) => (
					<Stack key={group.key} gap="xs">
						<Group justify="space-between" align="baseline">
							<Text size="sm" fw={500}>
								{group.label}
							</Text>
							<Text size="xs" c="dimmed">
								<Plural
									value={group.rows.length}
									one="# payment"
									other="# payments"
								/>
							</Text>
						</Group>
						<SimpleDataTable<PaymentRow>
							columns={columns}
							data={group.rows}
							globalFilter={globalFilter}
							onGlobalFilterChange={setGlobalFilter}
							initialSorting={[{ desc: true, id: "created_at" }]}
							emptyLabel={t`No payments match the filter.`}
						/>
					</Stack>
				))
			)}
		</Stack>
	);
}

/**
 * Stable host for a staff section a later wave fills in. Wave C
 * (managed-billing controls) and Wave E (training provisioning) each mount
 * onto one of these so they only add a panel, never touch routing or the tab
 * switch. Replace the body with the real controls when the wave lands.
 */
function StaffSectionPlaceholder({
	title,
	description,
}: {
	title: string;
	description: string;
}) {
	return (
		<Paper withBorder radius="sm" p="lg">
			<Stack gap="xs">
				<Group gap="xs" align="center">
					<Text size="sm" fw={500}>
						{title}
					</Text>
					<Badge size="xs" color="gray" variant="light">
						<Trans>Coming soon</Trans>
					</Badge>
				</Group>
				<Text size="xs" c="dimmed">
					{description}
				</Text>
			</Stack>
		</Paper>
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
								Usage and billing, payments, partner ledger. Any Directus admin
								has access.
							</Trans>
						</Text>
					</Stack>
				</Group>
				{/* Tab strip retired — section navigation lives in the main
				    AppSidebar (AdminHomeView). Tabs.Panel still switches on value. */}
				<Tabs
					value={active}
					onChange={(v) => v && navigate(`/admin/${v}`, { replace: true })}
					keepMounted={false}
				>
					<Tabs.Panel value="usage-and-billing" pt="md">
						<UsageAndBillingPanel />
					</Tabs.Panel>
					<Tabs.Panel value="payments" pt="md">
						<PaymentsPanel />
					</Tabs.Panel>
					<Tabs.Panel value="partners" pt="md">
						<PartnersPanel />
					</Tabs.Panel>
					{/* Stable hosts for later waves. Wave C swaps in managed-billing
					    controls (set managed, assign an @dembrane.com account
					    manager, issue an offline invoice); Wave E swaps in training
					    provisioning + the trained-vs-not verification view. Each
					    only replaces its panel body. Routing + tab switch stay. */}
					<Tabs.Panel value="managed-billing" pt="md">
						<StaffSectionPlaceholder
							title={t`Managed billing`}
							description={t`Set an account managed, assign an account manager, and issue an offline invoice. Lands with Wave C.`}
						/>
					</Tabs.Panel>
					<Tabs.Panel value="training" pt="md">
						<StaffSectionPlaceholder
							title={t`Training`}
							description={t`Provision a training, mark completion, and see who is trained. Lands with Wave E.`}
						/>
					</Tabs.Panel>
				</Tabs>
			</Stack>
		</Container>
	);
};
