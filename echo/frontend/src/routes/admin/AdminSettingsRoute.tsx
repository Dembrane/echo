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
	IconArrowsSort,
	IconChevronDown,
	IconChevronRight,
	IconDots,
	IconDownload,
	IconExternalLink,
	IconSearch,
	IconSortAscending,
	IconSortDescending,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	type ColumnDef,
	flexRender,
	getCoreRowModel,
	getFilteredRowModel,
	getSortedRowModel,
	type SortingState,
	useReactTable,
} from "@tanstack/react-table";
import { Fragment, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { ConfirmModal } from "@/components/common/ConfirmModal";
import { I18nLink } from "@/components/common/i18nLink";
import { toast } from "@/components/common/Toaster";
import { UsageFreshness } from "@/components/common/UsageFreshness";
import { API_BASE_URL } from "@/config";
import { useV2Me } from "@/hooks/useV2Me";
import { type BillingPeriod, TIER_ORDER, type Tier } from "@/lib/tiers";

const _tierRank = (tier: string): number => TIER_ORDER.indexOf(tier as Tier);

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
	org_is_partner: boolean;
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

// One billing account: the paying entity, pooling its workspaces' seats. The
// dashboard pivots on this (ISSUE-025); per-workspace detail lives in
// `workspaces` for drill-down.
type AccountRow = {
	billing_account_id: string;
	label: string;
	account_scope: "organisation" | "workspace" | null;
	org_id: string | null;
	org_name: string | null;
	tier: string;
	workspace_count: number;
	active_workspace_count: number;
	seat_count: number;
	external_count: number;
	base_price_eur: number | null;
	total_forecast_eur: number;
	is_trial: boolean;
	is_managed: boolean;
	is_comped: boolean;
	is_active: boolean;
	tier_expires_at: string | null;
	type_discount: string | null;
	percent_discount: number | null;
	payment_mode: string | null;
	workspaces: BillingRow[];
};

type BillingRollup = {
	cycle_start: string;
	cycle_end_exclusive: string;
	workspace_count: number;
	active_workspace_count: number;
	account_count: number;
	active_account_count: number;
	trial_account_count: number;
	managed_account_count: number;
	comped_account_count: number;
	total_base_eur: number;
	total_overage_eur: number;
	total_forecast_eur: number;
	mrr_eur: number;
	logins_last_30d: number;
	accounts: AccountRow[];
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
 * Inline discount editor. The discount is canonical on the billing account, so
 * this writes the account row (not the workspace): the account-level value is
 * what every price path reads, and editing the workspace would let the two
 * diverge. Lives on the account in AccountActionsModal.
 */
function DiscountEditor({
	accountId,
	initialType,
	initialPercent,
}: {
	accountId: string;
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
				`${API_BASE_URL}/v2/admin/billing-accounts/${accountId}/discount`,
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
 * Live staff action: toggle the org partner flag (Founder decision D1).
 * A partner org's workspaces self-identify internal vs external client use on
 * creation. There is no secret code, this flag is the whole gate.
 */
function OrgPartnerToggle({
	orgId,
	orgName,
	isPartner,
}: {
	orgId: string;
	orgName: string;
	isPartner: boolean;
}) {
	const queryClient = useQueryClient();
	const mutation = useMutation({
		mutationFn: async (next: boolean) => {
			const res = await fetch(
				`${API_BASE_URL}/v2/admin/orgs/${orgId}/partner`,
				{
					body: JSON.stringify({ is_partner: next }),
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
			<Group justify="space-between" wrap="nowrap" align="center">
				<Stack gap={0} style={{ minWidth: 0 }}>
					<Text size="sm" fw={500}>
						<Trans>Partner organisation</Trans>
					</Text>
					<Text size="xs" c="dimmed">
						<Trans>
							Marks {orgName} as a partner. Its workspaces self-identify
							internal vs external client use on creation.
						</Trans>
					</Text>
					{mutation.isError && (
						<Text size="xs" c="red">
							{(mutation.error as Error).message}
						</Text>
					)}
				</Stack>
				<Checkbox
					checked={isPartner}
					disabled={mutation.isPending}
					onChange={(e) => mutation.mutate(e.currentTarget.checked)}
					label={<Trans>Partner</Trans>}
				/>
			</Group>
		</Paper>
	);
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
 * Actions modal for a workspace row. Live staff edits (partner toggle, discount,
 * trial, change tier, change admin, reset usage). Transfer-to-partner and
 * delete-workspace stay disabled (destructive, deferred to their own issues).
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

				<OrgPartnerToggle
					orgId={row.org_id}
					orgName={row.org_name}
					isPartner={row.org_is_partner}
				/>

				<Divider my={4} />

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

/**
 * Account label for an account row. Mirrors `accountScopeLabel` but reads the
 * account's own scope.
 */
function accountRowScopeLabel(scope: AccountRow["account_scope"]): string {
	if (scope === "organisation") return t`Organisation account`;
	if (scope === "workspace") return t`Workspace account`;
	return t`Account`;
}

/**
 * Human identifying name for an account row. Staff want "who is this", not an
 * id: prefer the org name for an organisation account and the single
 * workspace's name for a workspace account, then fall back to the account
 * label, then a short id.
 */
function accountIdentifyingName(account: AccountRow): string {
	if (account.account_scope === "organisation" && account.org_name) {
		return account.org_name;
	}
	if (account.account_scope === "workspace") {
		const ws = account.workspaces[0];
		if (ws?.workspace_name) return ws.workspace_name;
	}
	if (account.label) return account.label;
	return account.billing_account_id.slice(0, 8);
}

/**
 * Trial / Managed badges for an account. Trial shows the expiry; both add €0 to
 * the paying revenue total (Managed is offline-invoiced and so counts, but we
 * still flag it so staff know there is no Mollie mandate behind it).
 */
function AccountBadges({ account }: { account: AccountRow }) {
	return (
		<>
			{account.is_trial && (
				<Tooltip
					label={
						account.tier_expires_at
							? t`Comped trial. Expires ${formatDate(account.tier_expires_at)}. €0 revenue.`
							: t`Comped trial. €0 revenue.`
					}
					withArrow
				>
					<Badge size="xs" color="orange" variant="light">
						<Trans>Trial</Trans>
					</Badge>
				</Tooltip>
			)}
			{account.is_managed && (
				<Tooltip label={t`Invoiced offline, no Mollie mandate.`} withArrow>
					<Badge size="xs" color="grape" variant="light">
						<Trans>Managed</Trans>
					</Badge>
				</Tooltip>
			)}
		</>
	);
}

/**
 * Account-scoped actions modal. Tier lives on the billing account, so changing
 * it here applies to every workspace the account pools. Grant-trial is keyed on
 * the account id. Workspace-scoped actions (change admin, reset usage, discount)
 * are reached per workspace through `WorkspaceActionsModal`.
 */
function AccountActionsModal({
	account,
	opened,
	onClose,
	onOpenWorkspace,
}: {
	account: AccountRow | null;
	opened: boolean;
	onClose: () => void;
	onOpenWorkspace: (row: BillingRow) => void;
}) {
	if (!account) return null;
	// Tier writes target the account; any of its workspaces routes there via
	// PATCH /v2/workspaces/{id}/tier. Use the first workspace as the handle.
	const tierHandle = account.workspaces[0] ?? null;
	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={
				<Group gap="xs">
					<Text fw={500}>{accountIdentifyingName(account)}</Text>
					<Badge
						size="xs"
						color={tierColors[account.tier] ?? "gray"}
						variant="light"
						tt="capitalize"
					>
						{account.tier}
					</Badge>
					<Badge size="xs" color="gray" variant="outline">
						{accountRowScopeLabel(account.account_scope)}
					</Badge>
					<AccountBadges account={account} />
				</Group>
			}
			size="md"
		>
			<Stack gap="xs">
				<Text size="xs" c="dimmed">
					<Trans>
						{account.workspace_count} workspaces,{" "}
						{account.seat_count + account.external_count} seats pooled
					</Trans>
				</Text>
				<Divider my={4} />

				<DiscountEditor
					accountId={account.billing_account_id}
					initialType={account.type_discount ?? null}
					initialPercent={account.percent_discount ?? null}
				/>

				{tierHandle && <ChangeTierControl row={tierHandle} />}
				<GrantTrialControl accountId={account.billing_account_id} />

				<Divider my={4} />
				<Text size="xs" c="dimmed">
					<Trans>Workspaces in this account</Trans>
				</Text>
				{account.workspaces.map((ws) => (
					<Paper key={ws.workspace_id} withBorder radius="sm" p="sm">
						<Group justify="space-between" wrap="nowrap" align="center">
							<Stack gap={0} style={{ minWidth: 0 }}>
								<Text size="sm" fw={500} truncate>
									{ws.workspace_name}
								</Text>
								<Text size="xs" c="dimmed">
									{ws.is_active ? t`Active` : t`Inactive`},{" "}
									{ws.seat_count + ws.external_count} seats
								</Text>
							</Stack>
							<Button
								size="xs"
								variant="outline"
								color="gray"
								onClick={() => {
									onClose();
									onOpenWorkspace(ws);
								}}
							>
								<Trans>Workspace actions</Trans>
							</Button>
						</Group>
					</Paper>
				))}
			</Stack>
		</Modal>
	);
}

/**
 * Account-primary rollup table. Each row is a billing account; expanding it
 * reveals the account's workspaces with a per-workspace kebab. Comped/trial
 * accounts sort to the bottom (server-side) and never feed the paying total.
 */
function AccountBillingTable({
	accounts,
	onOpenAccount,
	onOpenWorkspace,
	payingTotal,
}: {
	accounts: AccountRow[];
	onOpenAccount: (account: AccountRow) => void;
	onOpenWorkspace: (row: BillingRow) => void;
	payingTotal: number;
}) {
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});
	const toggle = (id: string) => setExpanded((e) => ({ ...e, [id]: !e[id] }));

	if (accounts.length === 0) {
		return (
			<Text size="sm" c="dimmed">
				<Trans>No billing accounts match the current filters.</Trans>
			</Text>
		);
	}

	return (
		<Table.ScrollContainer minWidth={720}>
			<Table verticalSpacing="xs" highlightOnHover>
				<Table.Thead>
					<Table.Tr>
						<Table.Th style={{ width: 28 }} />
						<Table.Th>
							<Trans>Account</Trans>
						</Table.Th>
						<Table.Th>
							<Trans>Tier</Trans>
						</Table.Th>
						<Table.Th style={{ textAlign: "right" }}>
							<Trans>Workspaces</Trans>
						</Table.Th>
						<Table.Th style={{ textAlign: "right" }}>
							<Trans>Seats</Trans>
						</Table.Th>
						<Table.Th style={{ textAlign: "right" }}>
							<Trans>Forecast</Trans>
						</Table.Th>
						<Table.Th style={{ width: 36 }} />
					</Table.Tr>
				</Table.Thead>
				<Table.Tbody>
					{accounts.map((account) => {
						const isOpen = expanded[account.billing_account_id] ?? false;
						return (
							<Fragment key={account.billing_account_id}>
								<Table.Tr
									style={account.is_comped ? { opacity: 0.85 } : undefined}
								>
									<Table.Td>
										<ActionIcon
											size="sm"
											variant="subtle"
											color="gray"
											onClick={() => toggle(account.billing_account_id)}
											aria-label={t`Expand workspaces`}
										>
											{isOpen ? (
												<IconChevronDown size={14} />
											) : (
												<IconChevronRight size={14} />
											)}
										</ActionIcon>
									</Table.Td>
									<Table.Td>
										<Stack gap={2} style={{ minWidth: 0 }}>
											<Group gap={6} wrap="nowrap">
												<Text size="xs" fw={500} truncate maw={220}>
													{accountIdentifyingName(account)}
												</Text>
												<AccountBadges account={account} />
											</Group>
											<Text size="xs" c="dimmed">
												{accountRowScopeLabel(account.account_scope)}
											</Text>
										</Stack>
									</Table.Td>
									<Table.Td>
										<Badge
											size="xs"
											color={tierColors[account.tier] ?? "gray"}
											variant="light"
											tt="capitalize"
										>
											{account.tier}
										</Badge>
									</Table.Td>
									<Table.Td style={{ textAlign: "right" }}>
										<Text size="xs">
											{account.active_workspace_count}/{account.workspace_count}
										</Text>
									</Table.Td>
									<Table.Td style={{ textAlign: "right" }}>
										<Text size="xs">
											{account.seat_count + account.external_count}
										</Text>
									</Table.Td>
									<Table.Td style={{ textAlign: "right" }}>
										{account.is_comped ? (
											<Text size="xs" c="dimmed">
												€0
											</Text>
										) : (
											<Text size="xs" fw={500}>
												{formatEur(account.total_forecast_eur)}
											</Text>
										)}
									</Table.Td>
									<Table.Td>
										<ActionIcon
											size="sm"
											variant="subtle"
											color="gray"
											onClick={() => onOpenAccount(account)}
											aria-label={t`Open account actions`}
										>
											<IconDots size={14} />
										</ActionIcon>
									</Table.Td>
								</Table.Tr>
								<Table.Tr>
									<Table.Td colSpan={7} p={0} style={{ border: 0 }}>
										<Collapse in={isOpen}>
											<Box px="md" py="xs">
												<Table verticalSpacing={4} withRowBorders={false}>
													<Table.Tbody>
														{account.workspaces.map((ws) => (
															<Table.Tr key={ws.workspace_id}>
																<Table.Td>
																	<Anchor
																		component={I18nLink}
																		to={`/w/${ws.workspace_id}/settings/billing`}
																		size="xs"
																	>
																		{ws.workspace_name}
																	</Anchor>
																</Table.Td>
																<Table.Td>
																	{ws.is_active ? (
																		<Badge
																			size="xs"
																			color="primary"
																			variant="light"
																		>
																			<Trans>Active</Trans>
																		</Badge>
																	) : (
																		<Badge
																			size="xs"
																			color="gray"
																			variant="light"
																		>
																			<Trans>Inactive</Trans>
																		</Badge>
																	)}
																</Table.Td>
																<Table.Td style={{ textAlign: "right" }}>
																	<UsageBar
																		used={ws.audio_hours}
																		cap={ws.audio_hours_included}
																		unit="h"
																		block={ws.pilot_hard_block}
																	/>
																</Table.Td>
																<Table.Td style={{ textAlign: "right" }}>
																	<Text size="xs">
																		{ws.seat_count + ws.external_count}{" "}
																		<Trans>seats</Trans>
																	</Text>
																</Table.Td>
																<Table.Td style={{ width: 36 }}>
																	<ActionIcon
																		size="sm"
																		variant="subtle"
																		color="gray"
																		onClick={() => onOpenWorkspace(ws)}
																		aria-label={t`Open workspace actions`}
																	>
																		<IconDots size={14} />
																	</ActionIcon>
																</Table.Td>
															</Table.Tr>
														))}
													</Table.Tbody>
												</Table>
											</Box>
										</Collapse>
									</Table.Td>
								</Table.Tr>
							</Fragment>
						);
					})}
				</Table.Tbody>
				<Table.Tfoot>
					<Table.Tr>
						<Table.Td />
						<Table.Td>
							<Text size="xs" fw={500}>
								<Trans>Paying revenue</Trans>
							</Text>
						</Table.Td>
						<Table.Td colSpan={3} />
						<Table.Td style={{ textAlign: "right" }}>
							<Text size="xs" fw={500}>
								{formatEur(payingTotal)}
							</Text>
						</Table.Td>
						<Table.Td />
					</Table.Tr>
				</Table.Tfoot>
			</Table>
		</Table.ScrollContainer>
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
	const [statusFilter, setStatusFilter] = useState<
		"all" | "active" | "inactive"
	>("all");
	const [tierFilter, setTierFilter] = useState<string[]>([]);
	// Workspace-scoped actions (change admin, reset usage, discount). Reached by
	// drilling into an account row's workspaces.
	const [actionsRow, setActionsRow] = useState<BillingRow | null>(null);
	// Account-scoped actions (change tier, grant trial). Tier lives on the
	// account, so this is the right unit for it.
	const [actionsAccount, setActionsAccount] = useState<AccountRow | null>(null);

	// Account-primary view: filter accounts by the chips. A search/tier/status
	// match on any of an account's workspaces keeps the account.
	const accountsForView = useMemo(() => {
		const accounts = data?.accounts ?? [];
		const q = globalFilter.trim().toLowerCase();
		return accounts.filter((a) => {
			if (statusFilter === "active" && !a.is_active) return false;
			if (statusFilter === "inactive" && a.is_active) return false;
			if (tierFilter.length > 0 && !tierFilter.includes(a.tier)) return false;
			if (q) {
				const haystack = [
					a.label,
					a.org_name ?? "",
					a.tier,
					...a.workspaces.map((w) => w.workspace_name),
					...a.workspaces.flatMap((w) =>
						w.workspace_admins.map((c) => c.email ?? ""),
					),
				]
					.join(" ")
					.toLowerCase();
				if (!haystack.includes(q)) return false;
			}
			return true;
		});
	}, [data, globalFilter, statusFilter, tierFilter]);

	// Workspace rows behind the filtered accounts, for the tier breakdown + CSV.
	const prefiltered = useMemo(
		() => accountsForView.flatMap((a) => a.workspaces),
		[accountsForView],
	);

	// Paying total over the filtered accounts (comped/trial already forecast €0).
	const payingTotal = useMemo(
		() => accountsForView.reduce((s, a) => s + a.total_forecast_eur, 0),
		[accountsForView],
	);
	const compedCount = useMemo(
		() => accountsForView.filter((a) => a.is_comped).length,
		[accountsForView],
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
			"billing_account_id",
			"account_label",
			"account_scope",
			"workspace_id",
			"workspace_name",
			"organisation",
			"tier",
			"payment_mode",
			"is_trial",
			"is_managed",
			"tier_expires_at",
			"type_discount",
			"percent_discount",
			"audio_hours",
			"audio_hours_included",
			"seat_count",
			"seats_included",
			"external_count",
			"base_price_eur",
			"account_forecast_eur",
			"workspace_admin_email",
			"is_active",
		];
		const lines = accountsForView.flatMap((a) =>
			a.workspaces.map((r) =>
				[
					a.billing_account_id,
					a.label,
					a.account_scope ?? "",
					r.workspace_id,
					r.workspace_name,
					r.billed_to_team_name ?? r.org_name,
					a.tier,
					a.payment_mode ?? "",
					a.is_trial ? "yes" : "no",
					a.is_managed ? "yes" : "no",
					a.tier_expires_at ?? "",
					a.type_discount ?? "",
					a.percent_discount ?? "",
					r.audio_hours.toFixed(2),
					r.audio_hours_included ?? "",
					r.seat_count,
					r.seats_included ?? "",
					r.external_count,
					a.base_price_eur ?? "",
					a.total_forecast_eur,
					r.workspace_admins[0]?.email ?? "",
					r.is_active ? "yes" : "no",
				]
					.map((v) => `"${String(v).replace(/"/g, '""')}"`)
					.join(","),
			),
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

	return (
		<Stack gap="md">
			<Group justify="space-between" align="flex-end" wrap="wrap">
				<Stack gap={2}>
					<Text size="sm" c="dimmed">
						<Trans>Usage and billing, {cycleLabel}</Trans>
					</Text>
					<Text size="xs" c="dimmed">
						<Trans>
							{data.account_count} accounts, {data.workspace_count} workspaces,{" "}
							{data.active_workspace_count} active
						</Trans>
					</Text>
				</Stack>
				<PeriodSelector value={periodOffset} onChange={setPeriodOffset} />
			</Group>

			<Group gap="md" wrap="wrap" align="center">
				<Text size="sm">
					<Trans>Paying revenue this month</Trans>{" "}
					<Text span fw={600}>
						{formatEur(payingTotal)}
					</Text>
				</Text>
				{compedCount > 0 && (
					<Tooltip
						label={t`Trial and comped accounts, excluded from the paying total.`}
						withArrow
					>
						<Badge size="sm" color="orange" variant="light">
							<Plural value={compedCount} one="# comped" other="# comped" />
						</Badge>
					</Tooltip>
				)}
			</Group>

			<Group gap="sm" wrap="wrap" align="center">
				<TextInput
					leftSection={<IconSearch size={14} />}
					placeholder={t`Search account, workspace, organisation, email, tier`}
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
						variant={statusFilter === "all" ? "filled" : "outline"}
						color={statusFilter === "all" ? "primary" : "gray"}
						onClick={() => setStatusFilter("all")}
					>
						<Trans>All</Trans>
					</Button>
					<Button
						size="xs"
						variant={statusFilter === "active" ? "filled" : "outline"}
						color={statusFilter === "active" ? "primary" : "gray"}
						onClick={() => setStatusFilter("active")}
					>
						<Trans>Active</Trans>
					</Button>
					<Button
						size="xs"
						variant={statusFilter === "inactive" ? "filled" : "outline"}
						color="gray"
						onClick={() => setStatusFilter("inactive")}
					>
						<Trans>Inactive</Trans>
					</Button>
				</Button.Group>
				<Button
					size="xs"
					variant="outline"
					color="gray"
					leftSection={<IconDownload size={14} />}
					onClick={handleExport}
				>
					<Trans>Export CSV</Trans>
				</Button>
			</Group>

			<AccountBillingTable
				accounts={accountsForView}
				onOpenAccount={setActionsAccount}
				onOpenWorkspace={setActionsRow}
				payingTotal={payingTotal}
			/>

			<TierBreakdownPanel rows={prefiltered} />

			<UsageFreshness
				dataUpdatedAt={dataUpdatedAt}
				refreshing={refreshing}
				onRefresh={handleRefresh}
			/>

			<AccountActionsModal
				account={actionsAccount}
				opened={actionsAccount !== null}
				onClose={() => setActionsAccount(null)}
				onOpenWorkspace={setActionsRow}
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
