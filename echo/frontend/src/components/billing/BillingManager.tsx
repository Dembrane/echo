import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Anchor,
	Badge,
	Button,
	Divider,
	Group,
	Loader,
	Modal,
	Paper,
	Select,
	Stack,
	Text,
	Textarea,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import posthog from "posthog-js";
import { useCallback, useEffect, useState } from "react";

import { toast } from "@/components/common/Toaster";
import { BillingPeriodToggle } from "@/components/workspace/BillingPeriodToggle";
import { TierPricingCards } from "@/components/workspace/TierPricingCards";
import { API_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { type BillingPeriod, isComingSoon, SELLABLE_TIER } from "@/lib/tiers";

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

interface Overview {
	account_id: string | null;
	tier: string;
	status: string | null;
	billing_period: BillingPeriod | null;
	seats: number;
	next_invoice: NextInvoice | null;
	projected_monthly_eur: number | null;
	per_seat_monthly_eur: number | null;
	payment_method: PaymentMethod | null;
}

interface Invoice {
	id: string;
	created_at: string | null;
	amount: string;
	currency: string;
	status: string;
	description: string;
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

function eur(n: number | null | undefined): string {
	if (n == null) return "—";
	return `€${Math.round(n).toLocaleString()}`;
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
				<Text size="xs" fw={500} c="dimmed" tt="uppercase">
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
				<Text size="xs" c="dimmed">
					<Trans>
						This workspace is billed through {orgName}. Plans and payment are
						managed once for the whole organisation, and every workspace shares
						it.
					</Trans>
				</Text>
				<Group>
					<Button size="xs" onClick={() => navigate(`/o/${orgId}/billing`)}>
						<Trans>Manage organisation billing</Trans>
					</Button>
				</Group>
			</Stack>
		</Paper>
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

/** Pick a plan + cadence — used for first subscribe and for changing plan. */
function ChangePlanModal({
	opened,
	onClose,
	currentTier,
	defaultPeriod,
	submitting,
	onConfirm,
}: {
	opened: boolean;
	onClose: () => void;
	currentTier: string;
	defaultPeriod: BillingPeriod;
	submitting: boolean;
	onConfirm: (tier: string, period: BillingPeriod) => void;
}) {
	const [tier, setTier] = useState<string>(
		currentTier && currentTier !== "free" ? currentTier : SELLABLE_TIER,
	);
	const [period, setPeriod] = useState<BillingPeriod>(defaultPeriod);

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={t`Choose a plan`}
			size="72rem"
			centered
		>
			<Stack gap="md">
				<Group justify="center">
					<BillingPeriodToggle value={period} onChange={setPeriod} compact />
				</Group>
				<TierPricingCards
					value={tier}
					onChange={setTier}
					highlightTier={SELLABLE_TIER}
					billingPeriod={period}
				/>
				<Text size="xs" c="dimmed" ta="center">
					<Trans>Pricing is per user, not per workspace.</Trans>
				</Text>
				<Text size="xs" c="dimmed" ta="center">
					<Trans>
						You can use dembrane for free by self-hosting it. For bespoke
						compliance requirements,{" "}
						<Anchor href="mailto:support@dembrane.com" inherit>
							call us for a quote
						</Anchor>
						.
					</Trans>
				</Text>
				<Group justify="flex-end">
					<Button
						loading={submitting}
						disabled={isComingSoon(tier)}
						onClick={() => onConfirm(tier, period)}
					>
						{isComingSoon(tier) ? (
							<Trans>Coming soon</Trans>
						) : (
							<Trans>Continue to payment</Trans>
						)}
					</Button>
				</Group>
			</Stack>
		</Modal>
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
	const [invoices, setInvoices] = useState<Invoice[]>([]);
	const [cursor, setCursor] = useState<string | null>(null);
	const [loadingInvoices, setLoadingInvoices] = useState(false);
	const [planOpen, { open: openPlan, close: closePlan }] = useDisclosure(false);
	const [cancelOpen, { open: openCancel, close: closeCancel }] =
		useDisclosure(false);

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

	const refreshAll = useCallback(() => {
		queryClient.invalidateQueries({
			queryKey: ["v2", "billing", "overview", accountId],
		});
		for (const key of invalidateKeys) {
			queryClient.invalidateQueries({ queryKey: key as unknown[] });
		}
	}, [queryClient, accountId, invalidateKeys]);

	const loadInvoices = useCallback(
		async (from: string | null) => {
			if (!accountId) return;
			setLoadingInvoices(true);
			try {
				const qs = new URLSearchParams({ limit: "8" });
				if (from) qs.set("cursor", from);
				const res = await fetch(
					`${API_BASE_URL}/v2/billing-accounts/${accountId}/invoices?${qs}`,
					{ credentials: "include" },
				);
				if (res.ok) {
					const data = await res.json();
					setInvoices((prev) =>
						from ? [...prev, ...(data.invoices ?? [])] : (data.invoices ?? []),
					);
					setCursor(data.next ?? null);
				}
			} finally {
				setLoadingInvoices(false);
			}
		},
		[accountId],
	);

	useEffect(() => {
		if (accountId) loadInvoices(null);
	}, [accountId, loadInvoices]);

	// Returning from Mollie checkout: reconcile then refresh.
	// biome-ignore lint/correctness/useExhaustiveDependencies: run once per accountId on return from checkout
	useEffect(() => {
		const sp = new URLSearchParams(window.location.search);
		if (sp.get("billing") !== "return" || !accountId) return;
		(async () => {
			try {
				await fetch(`${API_BASE_URL}/v2/billing-accounts/${accountId}/sync`, {
					credentials: "include",
					method: "POST",
				});
				refreshAll();
				loadInvoices(null);
				toast.success(t`Subscription updated.`);
			} catch {
				toast.error(t`Could not confirm payment. Refresh to retry.`);
			}
			window.history.replaceState({}, "", window.location.pathname);
		})();
	}, [accountId]);

	const startCheckout = async (tier: string, period: BillingPeriod) => {
		if (!accountId || isComingSoon(tier)) return;
		setSubmitting(true);
		try {
			posthog.capture("checkout_started", { period, source, tier });
			const res = await fetch(
				`${API_BASE_URL}/v2/billing-accounts/${accountId}/checkout`,
				{
					body: JSON.stringify({
						billing_period: period,
						redirect_url: `${window.location.origin}${window.location.pathname}?billing=return`,
						tier,
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
			setSubmitting(false);
		}
	};

	if (!accountId) {
		return (
			<Paper withBorder p="md" radius="sm">
				<Text size="sm" c="dimmed">
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

	const tier = overview.tier || "free";
	const status = overview.status;
	const hasPaidPlan = tier !== "free";
	const isCanceling = status === "canceled";
	const period = overview.billing_period ?? "annual";

	// Free / never-subscribed: a focused subscribe prompt.
	if (!hasPaidPlan) {
		return (
			<Paper withBorder p="md" radius="sm">
				<Stack gap={12}>
					<Text size="sm" fw={500}>
						<Trans>Choose a plan</Trans>
					</Text>
					<Text size="xs" c="dimmed">
						<Trans>
							Billed per user. A seat is one member, counted automatically.
							Cancel anytime.
						</Trans>
					</Text>
					<Button onClick={openPlan} w="fit-content">
						<Trans>See plans</Trans>
					</Button>
				</Stack>
				<ChangePlanModal
					opened={planOpen}
					onClose={closePlan}
					currentTier={tier}
					defaultPeriod={period}
					submitting={submitting}
					onConfirm={startCheckout}
				/>
			</Paper>
		);
	}

	return (
		<Paper withBorder p="md" radius="sm">
			<Stack gap={16}>
				<SectionRow
					label={t`Current plan`}
					action={
						<Button size="xs" variant="subtle" onClick={openPlan}>
							<Trans>Change plan</Trans>
						</Button>
					}
				>
					<Group gap={8}>
						<Text size="sm" fw={500}>
							{tierLabel(tier)}
						</Text>
						<Badge
							size="xs"
							variant="light"
							color={
								isCanceling ? "yellow" : status === "past_due" ? "red" : "green"
							}
						>
							{isCanceling ? (
								<Trans>Not renewing</Trans>
							) : status === "past_due" ? (
								<Trans>Payment failed</Trans>
							) : (
								<Trans>Active</Trans>
							)}
						</Badge>
					</Group>
					<Text size="xs" c="dimmed">
						{period === "monthly" ? (
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
					<Text size="xs" c="dimmed">
						<Trans>
							A seat is one member. Add or remove members in each workspace's
							People tab; your next charge follows automatically.
						</Trans>
					</Text>
				</SectionRow>

				<Divider />

				<Group grow align="flex-start">
					<SectionRow label={t`Next invoice`}>
						{overview.next_invoice?.date ? (
							<>
								<Text size="sm">€{overview.next_invoice.amount}</Text>
								<Text size="xs" c="dimmed">
									{formatDate(overview.next_invoice.date)}
								</Text>
							</>
						) : (
							<Text size="sm" c="dimmed">
								<Trans>None scheduled</Trans>
							</Text>
						)}
					</SectionRow>

					<SectionRow label={t`Projected monthly total`}>
						<Text size="sm">{eur(overview.projected_monthly_eur)}</Text>
						{overview.per_seat_monthly_eur != null && (
							<Text size="xs" c="dimmed">
								<Trans>
									{eur(overview.per_seat_monthly_eur)} / seat × {overview.seats}
								</Trans>
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
							component="a"
							href="mailto:support@dembrane.com?subject=Change payment method"
						>
							<Trans>Change</Trans>
						</Button>
					}
				>
					<Text size="sm">{overview.payment_method?.label ?? t`Not set`}</Text>
				</SectionRow>

				<Divider />

				<Stack gap={6}>
					<Text size="xs" fw={500} c="dimmed" tt="uppercase">
						<Trans>Invoices</Trans>
					</Text>
					{invoices.length === 0 ? (
						<Text size="xs" c="dimmed">
							<Trans>No payments yet.</Trans>
						</Text>
					) : (
						invoices.map((inv) => (
							<Group
								key={inv.id}
								justify="space-between"
								gap="sm"
								wrap="nowrap"
							>
								<Text size="xs" c="dimmed" w={90}>
									{formatDate(inv.created_at)}
								</Text>
								<Text size="xs" style={{ flex: 1, minWidth: 0 }} truncate>
									{inv.description}
								</Text>
								<Text size="xs">€{inv.amount}</Text>
								<Badge
									size="xs"
									variant="light"
									color={inv.status === "paid" ? "green" : "gray"}
								>
									{inv.status}
								</Badge>
							</Group>
						))
					)}
					{cursor && (
						<Group justify="center">
							<Button
								size="xs"
								variant="subtle"
								loading={loadingInvoices}
								onClick={() => loadInvoices(cursor)}
							>
								<Trans>Load more</Trans>
							</Button>
						</Group>
					)}
				</Stack>

				<Divider />

				<Group justify="space-between" align="center">
					<Text size="xs" c="dimmed">
						{isCanceling ? (
							<Trans>Your plan ends at the period end.</Trans>
						) : (
							<Trans>
								Cancel anytime. You keep access until the period ends.
							</Trans>
						)}
					</Text>
					{isCanceling ? (
						<Button
							size="xs"
							loading={submitting}
							onClick={() => startCheckout(tier, period)}
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

			<ChangePlanModal
				opened={planOpen}
				onClose={closePlan}
				currentTier={tier}
				defaultPeriod={period}
				submitting={submitting}
				onConfirm={startCheckout}
			/>
			<CancelSubscriptionModal
				opened={cancelOpen}
				onClose={closeCancel}
				accountId={accountId}
				currentTier={tier}
				source={source}
				onCancelled={refreshAll}
			/>
		</Paper>
	);
}

/** Org billing tab body: resolves the org's billing account, then manages it. */
export function OrgBillingTab({ orgId }: { orgId: string }) {
	const { data, isLoading } = useQuery<{ account_id: string | null } | null>({
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

	return (
		<BillingManager
			accountId={data?.account_id ?? null}
			invalidateKeys={[["v2", "orgs", orgId, "billing"]]}
			source="org_billing"
		/>
	);
}
