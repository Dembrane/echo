import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Anchor,
	Badge,
	Button,
	Divider,
	Group,
	Loader,
	Modal,
	Paper,
	Select,
	SimpleGrid,
	Stack,
	Table,
	Text,
	Textarea,
	TextInput,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
	useInfiniteQuery,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import posthog from "posthog-js";
import { useCallback, useEffect, useState } from "react";

import { ConfirmModal } from "@/components/common/ConfirmModal";
import { toast } from "@/components/common/Toaster";
import { usePricingConfigurator } from "@/components/pricing";
import { UpgradeModal } from "@/components/workspace/FeatureGate";
import { API_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import type { BillingPeriod, Tier } from "@/lib/tiers";

export function tierLabel(tier: string | null | undefined): string {
	if (!tier) return "";
	return tier.charAt(0).toUpperCase() + tier.slice(1);
}

interface NextInvoice {
	date: string | null;
	amount: string | null;
	currency: string | null;
}

interface PaymentMethod {
	type: string | null;
	label: string;
}

interface AccountManager {
	name: string | null;
	email: string | null;
}

interface BillingDetails {
	billing_legal_name: string | null;
	billing_vat_id: string | null;
	billing_vat_region: "eu" | "non_eu" | "international" | null;
	billing_country: string | null;
	billing_address_line1: string | null;
	billing_address_line2: string | null;
	billing_postal_code: string | null;
	billing_city: string | null;
}

/**
 * The billing overview, minus `status`.
 *
 * `status` is deliberately NOT modelled here. It is unreliable: an account on
 * a paid `tier` with `payment_mode` of `none` reads as unpaid, because that
 * combination is how a tier is granted without a subscription. Everything
 * this component decides comes from `tier`, `payment_mode` (surfaced as
 * `is_managed`) and the Mollie ids (`has_active_subscription`,
 * `has_payment_history`). Leaving the field out of the type keeps it that way.
 */
interface Overview {
	account_id: string | null;
	tier: string;
	billing_period: BillingPeriod | null;
	seats: number;
	/** Paid-for-but-unfilled seats this period (a member left). Free to reassign until renewal. */
	available_seats: number;
	/** Date access ends when the plan is winding down. Null while renewing. */
	current_period_end: string | null;
	next_invoice: NextInvoice | null;
	projected_monthly_eur: number | null;
	per_seat_monthly_eur: number | null;
	payment_method: PaymentMethod | null;
	/** Pending (un-accepted) invites across the account. The bill rises by this
	 *  many seats when they're accepted. */
	pending_invites: number;
	/** Projected total once every pending invite is accepted. Null when none pending. */
	projected_with_pending_eur: number | null;
	/** Discount already applied to every amount above (and to the live Mollie
	 *  charge). 0 / null when there is no discount. */
	percent_discount: number | null;
	/** Reason tag for the discount (scholarship / staff_discount / trial). */
	type_discount: string | null;
	/** Set when a seat re-price against Mollie last failed (dead mandate / API
	 *  error); null when reconcile is clean. Drives the "fix your payment" prompt. */
	reconcile_failed_at: string | null;
	/** payment_mode is "offline": dembrane invoices this account. */
	is_managed: boolean;
	/** payment_mode is "mollie" AND a mollie_subscription_id exists. */
	has_active_subscription: boolean;
	/** A mollie_customer_id exists, so this account has checked out at least
	 *  once. Together with `has_active_subscription` this separates a customer
	 *  who cancelled (keeps the manage flow) from one dembrane comped (never
	 *  paid, so there is nothing to manage). */
	has_payment_history: boolean;
	account_manager: AccountManager | null;
	billing_details: BillingDetails | null;
}

/** What this page shows an account. Derived only from `tier`, `payment_mode`
 * and the Mollie ids. */
export interface BillingView {
	/** payment_mode is "offline": dembrane invoices them. */
	managed: boolean;
	/** Pays, or paid and then cancelled. The only case that gets the dashboard. */
	existingPayer: boolean;
	/** Paid before, no live subscription. Runs to the period end, then Free. */
	windingDown: boolean;
}

/**
 * The one entitlement rule on this page, kept pure so it can be walked in a
 * test rather than in a browser.
 *
 * It reads `tier`, `payment_mode` and `mollie_subscription_id` only, through
 * the three booleans the overview derives from them. It never reads `status`:
 * an account granted a paid tier holds `payment_mode` of `none`, and `status`
 * reports that as unpaid.
 *
 * Cancelling clears `mollie_subscription_id` and keeps `mollie_customer_id`.
 * That is what separates a customer who cancelled, who keeps the manage flow,
 * from an account dembrane comped, which never paid and has nothing to manage.
 */
export function billingView(overview: {
	is_managed: boolean;
	has_active_subscription: boolean;
	has_payment_history: boolean;
}): BillingView {
	const existingPayer =
		overview.has_active_subscription || overview.has_payment_history;
	return {
		existingPayer,
		managed: overview.is_managed,
		windingDown: existingPayer && !overview.has_active_subscription,
	};
}

interface Invoice {
	id: string;
	created_at: string | null;
	amount: string;
	currency: string;
	status: string;
	description: string;
	/** Hosted checkout link on an open/pending charge, so it can be paid now. */
	pay_url: string | null;
	/** Mollie sales-invoice id, when this row has a downloadable PDF (ISSUE-004). */
	sales_invoice_id?: string | null;
}

/** One page of the invoice ledger; `next` is the cursor for the following page. */
interface InvoicePage {
	invoices: Invoice[];
	next: string | null;
}

function formatDate(iso: string | null): string {
	if (!iso) return "";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
		year: "numeric",
	});
}

/** Date + time, for the invoice table (two charges can land on the same day). */
function formatDateTime(iso: string | null): string {
	if (!iso) return "";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleString(undefined, {
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		month: "short",
		year: "numeric",
	});
}

function eur(n: number | null | undefined): string {
	if (n == null) return "—";
	return `€${Math.round(n).toLocaleString()}`;
}

/**
 * A Mollie payment status, mapped to a customer-facing label, a badge colour,
 * and whether the amount represents a real charge. We hide the amount on
 * non-settled rows (failed / cancelled / expired): those were never debited, so
 * showing €900 next to them reads like an outstanding balance.
 */
function invoiceStatusMeta(status: string): {
	label: string;
	color: string;
	settled: boolean;
} {
	switch (status) {
		case "paid":
			return { color: "green", label: t`Paid`, settled: true };
		case "pending":
		case "open":
		case "authorized":
			return { color: "yellow", label: t`Pending`, settled: true };
		case "failed":
			return { color: "red", label: t`Failed`, settled: false };
		case "canceled":
			return { color: "gray", label: t`Cancelled`, settled: false };
		case "expired":
			return { color: "gray", label: t`Expired`, settled: false };
		default:
			return { color: "gray", label: status, settled: false };
	}
}

/**
 * The Mollie description carries a "Cancel anytime." marketing tail that reads
 * fine on the hosted checkout but doesn't belong on a financial record. Strip it
 * for the in-app invoice list so each row stays factual.
 */
function cleanInvoiceDescription(desc: string): string {
	return desc.replace(/\s*Cancel anytime\.?\s*$/i, "").trim();
}

function SectionRow({
	label,
	children,
	action,
}: {
	label: React.ReactNode;
	children: React.ReactNode;
	action?: React.ReactNode;
}) {
	return (
		<Group justify="space-between" align="flex-start" wrap="nowrap" gap="md">
			<Stack gap={2} style={{ minWidth: 0 }}>
				<Text size="xs" fw={500} tt="uppercase">
					{label}
				</Text>
				{children}
			</Stack>
			{action}
		</Group>
	);
}

/**
 * Shown on a workspace whose billing is handled by its organisation. Billing
 * lives one level up, the way DigitalOcean / Anthropic put billing on the
 * account, not each project.
 */
export function OrgManagedBillingNotice({
	orgId,
	orgName,
}: {
	orgId: string;
	orgName: string;
}) {
	const navigate = useI18nNavigate();
	return (
		<Paper withBorder p="md" radius="sm">
			<Stack gap={8}>
				<Text size="sm" fw={500}>
					<Trans>Billing is managed by your organisation</Trans>
				</Text>
				<Text size="xs">
					<Trans>
						This workspace is billed through {orgName}. Plans and payment are
						managed once for the whole organisation, and every workspace shares
						it.
					</Trans>
				</Text>
				<Group>
					<Button
						size="xs"
						onClick={() => navigate(`/o/${orgId}/settings/billing`)}
					>
						<Trans>Manage organisation billing</Trans>
					</Button>
				</Group>
			</Stack>
		</Paper>
	);
}

/**
 * Shown instead of the plan picker / checkout / change-method / cancel controls
 * when the account is managed by dembrane (payment_mode "offline"). Full feature
 * access is unchanged; only the self-serve payment controls are replaced.
 */
function ManagedBillingPanel({
	tier,
	seats,
	manager,
}: {
	tier: string;
	seats: number;
	manager: AccountManager | null;
}) {
	return (
		<Paper withBorder p="md" radius="sm">
			<Stack gap={16}>
				<SectionRow label={t`Current plan`}>
					<Group gap={8}>
						<Text size="sm" fw={500}>
							{tierLabel(tier)}
						</Text>
						<Badge size="xs" variant="light" color="green">
							<Trans>Managed by dembrane</Trans>
						</Badge>
					</Group>
					<Text size="xs">
						<Trans>
							Your plan is managed by dembrane. Contact your account manager to
							make changes.
						</Trans>
					</Text>
				</SectionRow>

				<Divider />

				<SectionRow label={t`Seats`}>
					<Text size="sm">
						<Trans>{seats} seats</Trans>
					</Text>
				</SectionRow>

				{manager?.email && (
					<>
						<Divider />
						<SectionRow label={t`Account manager`}>
							<Text size="sm">{manager.name ?? manager.email}</Text>
							<Anchor size="xs" href={`mailto:${manager.email}`}>
								{manager.email}
							</Anchor>
						</SectionRow>
					</>
				)}
			</Stack>
		</Paper>
	);
}

const VAT_REGIONS: { value: string; label: string }[] = [
	{ label: "EU", value: "eu" },
	{ label: "Non-EU", value: "non_eu" },
	{ label: "International", value: "international" },
];

/**
 * VAT + billing address capture (ISSUE-005). Universal: shown for every account
 * (managed and self-serve). Capture only, prices are quoted excl. VAT, no rate
 * logic runs here.
 */
function BillingDetailsForm({
	accountId,
	initial,
	onSaved,
}: {
	accountId: string;
	initial: BillingDetails | null;
	onSaved: () => void;
}) {
	const [form, setForm] = useState<BillingDetails>({
		billing_address_line1: initial?.billing_address_line1 ?? null,
		billing_address_line2: initial?.billing_address_line2 ?? null,
		billing_city: initial?.billing_city ?? null,
		billing_country: initial?.billing_country ?? null,
		billing_legal_name: initial?.billing_legal_name ?? null,
		billing_postal_code: initial?.billing_postal_code ?? null,
		billing_vat_id: initial?.billing_vat_id ?? null,
		billing_vat_region: initial?.billing_vat_region ?? null,
	});
	const [saving, setSaving] = useState(false);

	const set = (key: keyof BillingDetails, value: string | null) =>
		setForm((prev) => ({ ...prev, [key]: value }));

	const save = async () => {
		setSaving(true);
		try {
			const res = await fetch(
				`${API_BASE_URL}/v2/billing-accounts/${accountId}/billing-details`,
				{
					body: JSON.stringify(form),
					credentials: "include",
					headers: { "Content-Type": "application/json" },
					method: "PUT",
				},
			);
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				throw new Error(err.detail || `Failed (${res.status})`);
			}
			toast.success(t`Billing details saved.`);
			onSaved();
		} catch (e) {
			toast.error((e as Error).message);
		} finally {
			setSaving(false);
		}
	};

	return (
		<Stack gap={12}>
			<Text size="xs" fw={500} tt="uppercase">
				<Trans>Billing details</Trans>
			</Text>
			<Text size="xs">
				<Trans>Used on your invoices. Prices exclude VAT.</Trans>
			</Text>
			<TextInput
				size="sm"
				label={t`Legal entity name`}
				value={form.billing_legal_name ?? ""}
				onChange={(e) =>
					set("billing_legal_name", e.currentTarget.value || null)
				}
			/>
			<SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
				<TextInput
					size="sm"
					label={t`VAT ID`}
					placeholder={t`Optional`}
					value={form.billing_vat_id ?? ""}
					onChange={(e) => set("billing_vat_id", e.currentTarget.value || null)}
				/>
				<Select
					size="sm"
					label={t`VAT region`}
					placeholder={t`Select`}
					data={VAT_REGIONS}
					value={form.billing_vat_region}
					onChange={(v) =>
						set("billing_vat_region", v as BillingDetails["billing_vat_region"])
					}
				/>
			</SimpleGrid>
			<TextInput
				size="sm"
				label={t`Address line 1`}
				value={form.billing_address_line1 ?? ""}
				onChange={(e) =>
					set("billing_address_line1", e.currentTarget.value || null)
				}
			/>
			<TextInput
				size="sm"
				label={t`Address line 2`}
				placeholder={t`Optional`}
				value={form.billing_address_line2 ?? ""}
				onChange={(e) =>
					set("billing_address_line2", e.currentTarget.value || null)
				}
			/>
			<SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
				<TextInput
					size="sm"
					label={t`Postal code`}
					value={form.billing_postal_code ?? ""}
					onChange={(e) =>
						set("billing_postal_code", e.currentTarget.value || null)
					}
				/>
				<TextInput
					size="sm"
					label={t`City`}
					value={form.billing_city ?? ""}
					onChange={(e) => set("billing_city", e.currentTarget.value || null)}
				/>
				<TextInput
					size="sm"
					label={t`Country`}
					value={form.billing_country ?? ""}
					onChange={(e) =>
						set("billing_country", e.currentTarget.value || null)
					}
				/>
			</SimpleGrid>
			<Group justify="flex-end">
				<Button size="xs" loading={saving} onClick={save}>
					<Trans>Save billing details</Trans>
				</Button>
			</Group>
		</Stack>
	);
}

const CANCEL_REASONS: { value: string; label: string }[] = [
	{ label: "Too expensive", value: "too_expensive" },
	{ label: "Missing features I need", value: "missing_features" },
	{ label: "Not using it enough", value: "not_using" },
	{ label: "Switching to another tool", value: "switching" },
	{ label: "Just pausing for now", value: "temporary" },
	{ label: "Other", value: "other" },
];

/** Confirm cancellation + a short churn survey (reason + optional note). */
function CancelSubscriptionModal({
	opened,
	onClose,
	accountId,
	currentTier,
	source,
	onCancelled,
}: {
	opened: boolean;
	onClose: () => void;
	accountId: string;
	currentTier: string;
	source: string;
	onCancelled: () => void;
}) {
	const [reason, setReason] = useState<string | null>(null);
	const [feedback, setFeedback] = useState("");
	const [submitting, setSubmitting] = useState(false);

	const submit = async () => {
		setSubmitting(true);
		try {
			const res = await fetch(
				`${API_BASE_URL}/v2/billing-accounts/${accountId}/cancel`,
				{
					body: JSON.stringify({ feedback: feedback || null, reason }),
					credentials: "include",
					headers: { "Content-Type": "application/json" },
					method: "POST",
				},
			);
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				throw new Error(err.detail || `Failed (${res.status})`);
			}
			posthog.capture("subscription_canceled", { reason, source });
			toast.success(
				t`Your plan won't renew. You keep access until the period ends.`,
			);
			onCancelled();
			onClose();
		} catch (e) {
			toast.error((e as Error).message);
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={t`Cancel your plan`}
			centered
			data-testid="billing-cancel-modal"
		>
			<Stack gap={12}>
				<Text size="sm">
					<Trans>
						Cancelling stops your plan from renewing. You keep{" "}
						{tierLabel(currentTier)} until your current billing period ends,
						then you move to Free.
					</Trans>
				</Text>
				<Select
					label={t`What's the main reason?`}
					placeholder={t`Pick one`}
					data={CANCEL_REASONS.map((r) => ({ label: r.label, value: r.value }))}
					value={reason}
					onChange={setReason}
					size="sm"
				/>
				<Textarea
					label={t`Anything we could have done better?`}
					placeholder={t`Optional`}
					value={feedback}
					onChange={(e) => setFeedback(e.currentTarget.value)}
					autosize
					minRows={2}
					size="sm"
				/>
				<Group justify="space-between">
					<Button variant="subtle" onClick={onClose} disabled={submitting}>
						<Trans>Keep my plan</Trans>
					</Button>
					<Button color="red" loading={submitting} onClick={submit}>
						<Trans>Cancel plan</Trans>
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}

/**
 * Shown to every account that has never paid: a free workspace, and a comped
 * one (a paid tier granted by dembrane, payment_mode "none").
 *
 * There is no plan picker, no price and no checkout here. A comped account
 * keeps every feature its tier gives it; it simply has nothing to settle.
 *
 * It carries the configurator. The two exceptions are the two panels above
 * this one, and `billingView` already decides between them: a managed account
 * keeps `ManagedBillingPanel`, an existing payer (paying now, or paid before
 * and cancelled) keeps the manage dashboard. This panel is the remainder, so
 * the rule is not re-derived here.
 *
 * This is the one entry that is not a wall. Nothing on this page is blocked,
 * so there is no control for a popover to sit on: the button opens the modal
 * directly and the modal reports `surface="modal"`. There is no required tier
 * either, which is why `requiredTier` is null: there is nothing to suppress.
 *
 * `canRequestUpgrade` is true because both billing surfaces are already behind
 * the financials permission: the organisation tab renders on `canSeeFinancials`
 * and the workspace tab on `seesFinancials`. Whoever reads this page can book
 * the call.
 */
function NothingToBillPanel({ tier }: { tier: string }) {
	const comped = tier !== "free";
	const configurator = usePricingConfigurator();
	return (
		<Paper withBorder p="md" radius="sm">
			<Stack gap={12}>
				<SectionRow label={t`Current plan`}>
					<Group gap={8}>
						<Text size="sm" fw={500}>
							{tierLabel(tier)}
						</Text>
						{comped && (
							<Badge size="xs" variant="light" color="green">
								<Trans>Arranged with dembrane</Trans>
							</Badge>
						)}
					</Group>
				</SectionRow>
				<Text size="xs">
					{comped ? (
						<Trans>
							Your plan is arranged with dembrane, so there is nothing to pay
							here. Everything your plan includes stays available.
						</Trans>
					) : (
						<Trans>
							You are on the free plan. There is no payment to manage yet.
						</Trans>
					)}
				</Text>
				<Text size="xs">
					<Trans>
						If you need something different, we will draft an offer for your use
						case.
					</Trans>
				</Text>
				<Group>
					<Button
						size="xs"
						onClick={configurator.open}
						data-testid="billing-configurator-start"
					>
						<Trans>Tell us what you need</Trans>
					</Button>
				</Group>
				<Text size="xs">
					<Trans>
						To talk about what you need, email{" "}
						<Anchor href="mailto:support@dembrane.com" inherit>
							support@dembrane.com
						</Anchor>
						.
					</Trans>
				</Text>
			</Stack>
			<UpgradeModal
				opened={configurator.opened}
				onClose={configurator.close}
				currentTier={tier as Tier}
				requiredTier={null}
				canRequestUpgrade
				workspaceId=""
				wallKey="billing_page"
				entry="modal_direct"
			/>
		</Paper>
	);
}

/** Open the downloadable PDF for a Mollie sales invoice (ISSUE-004). */
async function openInvoicePdf(accountId: string, salesInvoiceId: string) {
	try {
		const res = await fetch(
			`${API_BASE_URL}/v2/billing-accounts/${accountId}/invoices/${salesInvoiceId}/pdf`,
			{ credentials: "include" },
		);
		if (!res.ok) throw new Error(`Failed (${res.status})`);
		const data = await res.json();
		if (data.pdf_url) window.open(data.pdf_url, "_blank", "noopener");
		else toast.error(t`No PDF available for this invoice.`);
	} catch (e) {
		toast.error((e as Error).message);
	}
}

/** The in-app invoice table, with an optional PDF download per row. Shared by the
 *  self-serve dashboard and the managed-state view. */
function InvoiceList({
	invoices,
	hasMore,
	loadingInvoices,
	onLoadMore,
	accountId,
	source,
}: {
	invoices: Invoice[];
	hasMore: boolean;
	loadingInvoices: boolean;
	onLoadMore: () => void;
	accountId: string;
	source: string;
}) {
	const hasPdf = invoices.some((inv) => inv.sales_invoice_id);
	return (
		<Stack gap={6}>
			<Text size="xs" fw={500} tt="uppercase">
				<Trans>Invoices</Trans>
			</Text>
			{invoices.length === 0 ? (
				loadingInvoices ? (
					<Group justify="center" py="sm">
						<Loader size="sm" />
					</Group>
				) : (
					<Text size="xs">
						<Trans>No payments yet.</Trans>
					</Text>
				)
			) : (
				<Table verticalSpacing="xs" horizontalSpacing="sm" fz="xs">
					<Table.Thead>
						<Table.Tr>
							<Table.Th>
								<Trans>Date</Trans>
							</Table.Th>
							<Table.Th>
								<Trans>Description</Trans>
							</Table.Th>
							<Table.Th ta="right">
								<Trans>Amount</Trans>
							</Table.Th>
							<Table.Th ta="right">
								<Trans>Status</Trans>
							</Table.Th>
							{hasPdf && <Table.Th ta="right" />}
						</Table.Tr>
					</Table.Thead>
					<Table.Tbody>
						{invoices.map((inv) => {
							const meta = invoiceStatusMeta(inv.status);
							return (
								<Table.Tr key={inv.id}>
									<Table.Td style={{ whiteSpace: "nowrap" }}>
										{formatDateTime(inv.created_at)}
									</Table.Td>
									<Table.Td title={cleanInvoiceDescription(inv.description)}>
										{cleanInvoiceDescription(inv.description)}
									</Table.Td>
									{/* Amount only on settled rows; failed/cancelled/expired were never debited. */}
									<Table.Td ta="right" style={{ whiteSpace: "nowrap" }}>
										{meta.settled ? `€${inv.amount}` : ""}
									</Table.Td>
									<Table.Td ta="right">
										<Group gap={8} justify="flex-end" wrap="nowrap">
											{inv.pay_url && (
												<Anchor
													size="xs"
													href={inv.pay_url}
													onClick={() =>
														posthog.capture("invoice_pay_now_clicked", {
															source,
														})
													}
												>
													<Trans>Pay now</Trans>
												</Anchor>
											)}
											<Badge size="xs" variant="light" color={meta.color}>
												{meta.label}
											</Badge>
										</Group>
									</Table.Td>
									{hasPdf && (
										<Table.Td ta="right">
											{inv.sales_invoice_id && (
												<Button
													size="xs"
													variant="subtle"
													onClick={() =>
														openInvoicePdf(
															accountId,
															inv.sales_invoice_id as string,
														)
													}
												>
													<Trans>Download PDF</Trans>
												</Button>
											)}
										</Table.Td>
									)}
								</Table.Tr>
							);
						})}
					</Table.Tbody>
				</Table>
			)}
			{hasMore && (
				<Group justify="center">
					<Button
						size="xs"
						variant="subtle"
						loading={loadingInvoices}
						onClick={onLoadMore}
					>
						<Trans>Load more</Trans>
					</Button>
				</Group>
			)}
		</Stack>
	);
}

/**
 * Self-contained billing dashboard for an account. Fetches its own overview +
 * invoices. Renders a subscribe prompt on Free, or the full dashboard (plan,
 * seats, next invoice, projected total, payment method, invoices, cancel) on a
 * paid account. Used on the org billing tab and bill-separately workspaces.
 */
export function BillingManager({
	accountId,
	invalidateKeys = [],
	source,
}: {
	accountId: string | null;
	invalidateKeys?: readonly (readonly unknown[])[];
	source: string;
}) {
	const queryClient = useQueryClient();
	const [submitting, setSubmitting] = useState(false);
	const [updatingMethod, setUpdatingMethod] = useState(false);
	const [retrying, setRetrying] = useState(false);
	const [cancelOpen, { open: openCancel, close: closeCancel }] =
		useDisclosure(false);
	// Pre-redirect note so the EUR 0.00 verification on Mollie's hosted page
	// isn't a surprise: the swap captures a new mandate, it doesn't charge.
	const [
		methodConfirmOpen,
		{ open: openMethodConfirm, close: closeMethodConfirm },
	] = useDisclosure(false);

	const { data: overview, isLoading } = useQuery<Overview | null>({
		enabled: !!accountId,
		queryFn: async () => {
			const res = await fetch(
				`${API_BASE_URL}/v2/billing-accounts/${accountId}/overview`,
				{ credentials: "include" },
			);
			if (!res.ok) return null;
			return res.json();
		},
		queryKey: ["v2", "billing", "overview", accountId],
	});

	// Invoice ledger as a cached infinite list (deduped, refreshed by the same
	// invalidation as the rest of billing). Each page is { invoices, next }.
	const {
		data: invoicePages,
		isLoading: invoicesInitialLoading,
		isFetchingNextPage,
		hasNextPage,
		fetchNextPage,
	} = useInfiniteQuery({
		enabled: !!accountId,
		getNextPageParam: (last: InvoicePage) => last.next ?? undefined,
		initialPageParam: null as string | null,
		queryFn: async ({ pageParam }): Promise<InvoicePage> => {
			const qs = new URLSearchParams({ limit: "8" });
			if (pageParam) qs.set("cursor", pageParam);
			const res = await fetch(
				`${API_BASE_URL}/v2/billing-accounts/${accountId}/invoices?${qs}`,
				{ credentials: "include" },
			);
			if (!res.ok) throw new Error(`Failed (${res.status})`);
			return res.json() as Promise<InvoicePage>;
		},
		queryKey: ["v2", "billing", "invoices", accountId],
	});

	const invoices =
		invoicePages?.pages.flatMap((p: InvoicePage) => p.invoices ?? []) ?? [];
	// One flag for both render branches: initial load shows the empty-state
	// spinner, a "load more" shows the button spinner (they never overlap).
	const loadingInvoices = invoicesInitialLoading || isFetchingNextPage;

	const refreshAll = useCallback(() => {
		queryClient.invalidateQueries({
			queryKey: ["v2", "billing", "overview", accountId],
		});
		queryClient.invalidateQueries({
			queryKey: ["v2", "billing", "invoices", accountId],
		});
		for (const key of invalidateKeys) {
			queryClient.invalidateQueries({ queryKey: key as unknown[] });
		}
	}, [queryClient, accountId, invalidateKeys]);

	// Returning from Mollie checkout: reconcile, then report the real outcome.
	// biome-ignore lint/correctness/useExhaustiveDependencies: run once per accountId on return from checkout
	useEffect(() => {
		const sp = new URLSearchParams(window.location.search);
		if (sp.get("billing") !== "return" || !accountId) return;
		const flow = sp.get("flow"); // "checkout" | "method" | null
		// Consume the return marker synchronously (before any await) so React
		// StrictMode's double-invoke runs the reconcile + toast exactly once.
		window.history.replaceState({}, "", window.location.pathname);
		(async () => {
			try {
				const syncUrl = `${API_BASE_URL}/v2/billing-accounts/${accountId}/sync${
					flow ? `?flow=${encodeURIComponent(flow)}` : ""
				}`;
				const res = await fetch(syncUrl, {
					credentials: "include",
					method: "POST",
				});
				const data = res.ok ? await res.json().catch(() => ({})) : {};
				refreshAll();
				// A method swap reads its real outcome from `method_update`, which
				// is the Mollie consent payment, not the account state.
				//
				// The checkout return is gone with the checkout: this component no
				// longer starts a subscription, so `flow=checkout` can only arrive
				// from a link made before this change. We still reconcile it, and we
				// say nothing about it, because the only thing that could tell us
				// the outcome is the account `status` this page must not read.
				if (flow === "method") {
					const m = data.method_update;
					if (m === "paid") {
						toast.success(t`Your payment method has been updated.`);
					} else if (m === "failed" || m === "expired" || m === "canceled") {
						toast.error(
							t`We couldn't update your payment method. Your old one is still active. Please try again.`,
						);
					} else {
						toast(t`Your payment method update is still processing.`);
					}
				}
			} catch {
				toast.error(t`Could not confirm payment. Refresh to retry.`);
			}
		})();
	}, [accountId]);

	// Resume a plan that is winding down. The backend re-instates it with no
	// charge while the paid period still runs. It returns resumed=false when
	// there is nothing pre-paid left to ride; that used to fall through to a
	// fresh Mollie checkout, and no path in this component starts a subscription
	// any more, so it now says so and stops.
	const resumePlan = async (tier: string) => {
		if (!accountId) return;
		setSubmitting(true);
		try {
			const res = await fetch(
				`${API_BASE_URL}/v2/billing-accounts/${accountId}/resume`,
				{ credentials: "include", method: "POST" },
			);
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				throw new Error(err.detail || `Failed (${res.status})`);
			}
			const data = await res.json();
			if (data.resumed) {
				posthog.capture("subscription_resumed", { source, tier });
				toast.success(t`Your plan is back on. You keep your current period.`);
				refreshAll();
			} else {
				toast(
					t`Your paid period has run out, so we cannot put this plan back on from here. Email support@dembrane.com and we will sort it out with you.`,
				);
			}
		} catch (e) {
			toast.error((e as Error).message);
		} finally {
			setSubmitting(false);
		}
	};

	// ISSUE-002: capture a new payment method via a EUR 0.00 Mollie consent
	// payment. Returns to the billing page, where the sync effect reconciles.
	const updatePaymentMethod = async () => {
		if (!accountId) return;
		setUpdatingMethod(true);
		try {
			posthog.capture("payment_method_update_started", { source });
			const res = await fetch(
				`${API_BASE_URL}/v2/billing-accounts/${accountId}/payment-method/checkout`,
				{
					body: JSON.stringify({
						redirect_url: `${window.location.origin}${window.location.pathname}?billing=return&flow=method`,
					}),
					credentials: "include",
					headers: { "Content-Type": "application/json" },
					method: "POST",
				},
			);
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				throw new Error(err.detail || `Failed (${res.status})`);
			}
			const data = await res.json();
			window.location.href = data.checkout_url; // hosted Mollie checkout
		} catch (e) {
			toast.error((e as Error).message);
			setUpdatingMethod(false);
		}
	};

	// ISSUE-008: retry the outstanding charge off-session against the newest
	// valid mandate. On success the account flips back to active.
	const retryCharge = async () => {
		if (!accountId) return;
		setRetrying(true);
		try {
			posthog.capture("payment_retry_clicked", { source });
			const res = await fetch(
				`${API_BASE_URL}/v2/billing-accounts/${accountId}/retry-charge`,
				{ credentials: "include", method: "POST" },
			);
			if (!res.ok) {
				const err = await res.json().catch(() => ({}));
				throw new Error(err.detail || `Failed (${res.status})`);
			}
			const data = await res.json();
			// The endpoint answers with the account state its charge left behind.
			// That is the outcome of a charge this customer just asked us to make,
			// not an entitlement read: nothing on the page renders from it, and the
			// dashboard below refreshes from tier + payment_mode + the Mollie ids.
			const chargeSettled = data.status === "active";
			if (chargeSettled) {
				toast.success(t`Payment went through. Your plan is up to date.`);
			} else {
				toast.error(
					t`We still couldn't charge your method. Update it and try again.`,
				);
			}
			refreshAll();
		} catch (e) {
			toast.error((e as Error).message);
		} finally {
			setRetrying(false);
		}
	};

	if (!accountId) {
		return (
			<Paper withBorder p="md" radius="sm">
				<Text size="sm">
					<Trans>
						No billing account yet. Email{" "}
						<Anchor href="mailto:support@dembrane.com">
							support@dembrane.com
						</Anchor>{" "}
						and we'll set one up.
					</Trans>
				</Text>
			</Paper>
		);
	}

	if (isLoading || !overview) {
		return (
			<Group justify="center" py="lg">
				<Loader size="sm" />
			</Group>
		);
	}

	// Entitlement, read from tier + payment_mode + the Mollie ids. Never from
	// `status`. See billingView above for why.
	const tier = overview.tier || "free";
	const hasLiveSubscription = overview.has_active_subscription;
	const {
		managed: isManaged,
		existingPayer: isExistingPayer,
		windingDown: isWindingDown,
	} = billingView(overview);

	const discountPct = overview.percent_discount ?? 0;
	const period = overview.billing_period ?? "annual";
	const endDate = formatDate(overview.current_period_end);
	// Show the total at the cadence the customer is actually billed: a "monthly
	// total" next to an annual charge reads as irrelevant. Annual = monthly x 12.
	const isAnnual = !isWindingDown && period === "annual";
	const totalValue =
		isAnnual && overview.projected_monthly_eur != null
			? overview.projected_monthly_eur * 12
			: overview.projected_monthly_eur;

	// Pending invites aren't billed until accepted; surface where the total lands
	// once they are so the figure never quietly understates the bill.
	const pendingInvites = overview.pending_invites ?? 0;
	const hasPending = !isWindingDown && pendingInvites > 0;
	const withPendingValue =
		isAnnual && overview.projected_with_pending_eur != null
			? overview.projected_with_pending_eur * 12
			: overview.projected_with_pending_eur;
	// A charge we could not take. `reconcile_failed_at` covers a failed seat
	// re-price. The newest ledger row covers a failed renewal: that failure is
	// the event the account's `status` was set from, and the row is durable,
	// so we read the row instead of the flag it produced. Only meaningful while
	// a subscription is live, so an old failure cannot haunt a closed account.
	const reconcileFailed = !!overview.reconcile_failed_at;
	const chargeFailed =
		reconcileFailed ||
		(hasLiveSubscription && invoices[0]?.status === "failed");

	// Managed by dembrane (payment_mode "offline"): no self-serve controls.
	// Show the managed-state panel + the invoice list + billing-details capture.
	// Full feature access is unchanged; this is only the payment surface.
	if (isManaged) {
		return (
			<Stack gap={16}>
				<ManagedBillingPanel
					tier={tier}
					seats={overview.seats}
					manager={overview.account_manager}
				/>
				<Paper withBorder p="md" radius="sm">
					<Stack gap={16}>
						<InvoiceList
							invoices={invoices}
							hasMore={hasNextPage}
							loadingInvoices={loadingInvoices}
							onLoadMore={() => fetchNextPage()}
							accountId={accountId}
							source={source}
						/>
						<Divider />
						<BillingDetailsForm
							accountId={accountId}
							initial={overview.billing_details}
							onSaved={refreshAll}
						/>
					</Stack>
				</Paper>
			</Stack>
		);
	}

	// Never paid: a free workspace, or a comped one (paid tier, payment_mode
	// "none"). No plan picker, no price, no checkout. The comped account keeps
	// every feature its tier gives it.
	if (!isExistingPayer) {
		return <NothingToBillPanel tier={tier} />;
	}

	return (
		<Paper withBorder p="md" radius="sm">
			<Stack gap={16}>
				{chargeFailed && (
					<Alert
						color="red"
						title={t`We couldn't charge your payment method`}
						data-testid="billing-payment-failed"
						styles={{
							message: { color: "var(--app-text)" },
							title: { color: "var(--app-text)" },
						}}
					>
						<Stack gap={10}>
							<Text size="sm">
								<Trans>
									Your last payment didn't go through. Your plan stays active.
									Update your payment method or retry the charge to settle up.
								</Trans>
							</Text>
							<Group gap="sm">
								<Button
									size="xs"
									color="red"
									loading={retrying}
									onClick={retryCharge}
								>
									<Trans>Retry now</Trans>
								</Button>
								<Button
									size="xs"
									variant="outline"
									loading={updatingMethod}
									onClick={openMethodConfirm}
								>
									<Trans>Change payment method</Trans>
								</Button>
							</Group>
						</Stack>
					</Alert>
				)}
				<SectionRow label={t`Current plan`}>
					<Group gap={8}>
						<Text size="sm" fw={500}>
							{tierLabel(tier)}
						</Text>
						<Badge
							size="xs"
							variant="light"
							color={isWindingDown ? "yellow" : chargeFailed ? "red" : "green"}
						>
							{isWindingDown ? (
								<Trans>Not renewing</Trans>
							) : chargeFailed ? (
								<Trans>Payment failed</Trans>
							) : (
								<Trans>Active</Trans>
							)}
						</Badge>
					</Group>
					<Text size="xs">
						{isWindingDown && endDate ? (
							<Trans>Ends on {endDate}, then moves to Free</Trans>
						) : period === "monthly" ? (
							<Trans>Billed monthly</Trans>
						) : (
							<Trans>Billed annually</Trans>
						)}
					</Text>
				</SectionRow>

				<Divider />

				<SectionRow label={t`Seats`}>
					<Text size="sm">
						<Trans>{overview.seats} seats</Trans>
					</Text>
					{overview.available_seats > 0 && (
						<Text size="xs" c="var(--mantine-color-primary-6)">
							<Trans>
								{overview.available_seats} seat(s) paid for this period and
								unused. Invite someone to fill them at no charge until renewal.
							</Trans>
						</Text>
					)}
					{hasPending && (
						<Text size="xs" c="var(--mantine-color-primary-6)">
							<Trans>
								{pendingInvites} invite(s) pending. Counted once accepted.
							</Trans>
						</Text>
					)}
					<Text size="xs">
						{isWindingDown ? (
							<Trans>
								A seat is one member. Seats stay available until the plan ends;
								changes won't be charged.
							</Trans>
						) : (
							<Trans>
								A seat is one member. Add or remove members in each workspace's
								People tab; your next charge follows automatically.
							</Trans>
						)}
					</Text>
				</SectionRow>

				<Divider />

				<Group grow align="flex-start">
					{isWindingDown ? (
						<SectionRow label={t`Plan ends`}>
							{endDate ? (
								<Text size="sm">{endDate}</Text>
							) : (
								<Text size="sm">
									<Trans>At the end of this period</Trans>
								</Text>
							)}
							<Text size="xs">
								<Trans>No further charges</Trans>
							</Text>
						</SectionRow>
					) : (
						<SectionRow label={t`Next invoice`}>
							{overview.next_invoice?.date ? (
								<>
									<Text size="sm">€{overview.next_invoice.amount}</Text>
									<Text size="xs">
										{formatDate(overview.next_invoice.date)}
									</Text>
								</>
							) : (
								<Text size="sm">
									<Trans>None scheduled</Trans>
								</Text>
							)}
						</SectionRow>
					)}

					<SectionRow
						label={
							isWindingDown
								? t`Current rate`
								: isAnnual
									? t`Projected yearly total`
									: t`Projected monthly total`
						}
					>
						<Text size="sm">{eur(totalValue)}</Text>
						{overview.per_seat_monthly_eur != null && (
							<Text size="xs">
								{isWindingDown ? (
									<Trans>
										{eur(overview.per_seat_monthly_eur)} / seat ×{" "}
										{overview.seats}. Not charged after this period.
									</Trans>
								) : isAnnual ? (
									<Trans>
										{eur(overview.per_seat_monthly_eur)} / seat / month ×{" "}
										{overview.seats}, billed yearly. Excludes VAT.
									</Trans>
								) : (
									<Trans>
										{eur(overview.per_seat_monthly_eur)} / seat ×{" "}
										{overview.seats}. Excludes VAT.
									</Trans>
								)}
							</Text>
						)}
						{hasPending && withPendingValue != null && (
							<Text size="xs" c="var(--mantine-color-primary-6)">
								<Trans>
									{isAnnual ? "Yearly" : "Monthly"} total rises to{" "}
									{eur(withPendingValue)} when {pendingInvites} pending{" "}
									{pendingInvites === 1 ? "invite is" : "invites are"} accepted
								</Trans>
							</Text>
						)}
						{discountPct > 0 && (
							<Text size="xs" c="primary">
								<Trans>{discountPct}% discount applied</Trans>
							</Text>
						)}
					</SectionRow>
				</Group>

				<Divider />

				<SectionRow
					label={t`Payment method`}
					action={
						<Button
							size="xs"
							variant="subtle"
							loading={updatingMethod}
							onClick={openMethodConfirm}
						>
							{overview.payment_method ? (
								<Trans>Change</Trans>
							) : (
								<Trans>Add</Trans>
							)}
						</Button>
					}
				>
					<Text size="sm">{overview.payment_method?.label ?? t`Not set`}</Text>
				</SectionRow>

				<Divider />

				<InvoiceList
					invoices={invoices}
					hasMore={hasNextPage}
					loadingInvoices={loadingInvoices}
					onLoadMore={() => fetchNextPage()}
					accountId={accountId}
					source={source}
				/>

				<Divider />

				<BillingDetailsForm
					accountId={accountId}
					initial={overview.billing_details}
					onSaved={refreshAll}
				/>

				<Divider />

				<Group justify="space-between" align="center">
					<Text size="xs">
						{isWindingDown ? (
							endDate ? (
								<Trans>Your plan ends on {endDate}.</Trans>
							) : (
								<Trans>Your plan ends at the period end.</Trans>
							)
						) : (
							<Trans>
								Cancel anytime. You keep access until the period ends.
							</Trans>
						)}
					</Text>
					{isWindingDown ? (
						<Button
							size="xs"
							loading={submitting}
							onClick={() => resumePlan(tier)}
						>
							<Trans>Resume plan</Trans>
						</Button>
					) : (
						<Button size="xs" variant="subtle" color="red" onClick={openCancel}>
							<Trans>Cancel plan</Trans>
						</Button>
					)}
				</Group>
			</Stack>

			<CancelSubscriptionModal
				opened={cancelOpen}
				onClose={closeCancel}
				accountId={accountId}
				currentTier={tier}
				source={source}
				onCancelled={refreshAll}
			/>
			<ConfirmModal
				opened={methodConfirmOpen}
				onClose={closeMethodConfirm}
				onConfirm={() => {
					closeMethodConfirm();
					updatePaymentMethod();
				}}
				title={t`Change payment method`}
				message={t`You'll verify your new payment method on the next screen. You won't be charged, it just confirms the new card.`}
				confirmLabel={t`Continue`}
				loading={updatingMethod}
			/>
		</Paper>
	);
}

/** Org billing tab body: resolves the org's billing account, then manages it. */
interface SeparateWorkspaceAccount {
	workspace_id: string;
	name: string;
	account_id: string;
	tier: string;
}

export function OrgBillingTab({ orgId }: { orgId: string }) {
	const navigate = useI18nNavigate();
	const { data, isLoading } = useQuery<{
		account_id: string | null;
		separate_workspaces?: SeparateWorkspaceAccount[];
	} | null>({
		queryFn: async () => {
			const res = await fetch(`${API_BASE_URL}/v2/orgs/${orgId}/billing`, {
				credentials: "include",
			});
			if (!res.ok) return null;
			return res.json();
		},
		queryKey: ["v2", "orgs", orgId, "billing"],
	});

	if (isLoading) {
		return (
			<Group justify="center" py="lg">
				<Loader size="sm" />
			</Group>
		);
	}

	const separate = data?.separate_workspaces ?? [];

	return (
		<Stack gap="xl">
			<BillingManager
				accountId={data?.account_id ?? null}
				invalidateKeys={[["v2", "orgs", orgId, "billing"]]}
				source="org_billing"
			/>

			{separate.length > 0 && (
				<Stack gap="sm">
					<div>
						<Text size="sm" fw={500}>
							<Trans>Workspaces billed separately</Trans>
						</Text>
						<Text size="xs" c="dimmed">
							<Trans>
								These workspaces have their own plan, managed from each
								workspace. They aren't part of this organisation's plan.
							</Trans>
						</Text>
					</div>
					{separate.map((w) => (
						<Paper key={w.workspace_id} withBorder p="md" radius="sm">
							<Group justify="space-between" wrap="nowrap">
								<Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
									<Text size="sm" fw={500} truncate>
										{w.name}
									</Text>
									<Badge size="xs" variant="light" color="gray" tt="capitalize">
										{w.tier}
									</Badge>
								</Group>
								<Button
									size="xs"
									variant="subtle"
									onClick={() =>
										navigate(`/w/${w.workspace_id}/settings/billing`)
									}
								>
									<Trans>Manage</Trans>
								</Button>
							</Group>
						</Paper>
					))}
				</Stack>
			)}
		</Stack>
	);
}
