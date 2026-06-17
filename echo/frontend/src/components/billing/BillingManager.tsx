import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Anchor,
	Badge,
	Button,
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
import { useEffect, useState } from "react";

import { toast } from "@/components/common/Toaster";
import { BillingPeriodToggle } from "@/components/workspace/BillingPeriodToggle";
import { TierCapacityMatrix } from "@/components/workspace/TierCapacityMatrix";
import { TierPricingCards } from "@/components/workspace/TierPricingCards";
import { API_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { type BillingPeriod, isComingSoon, SELLABLE_TIER } from "@/lib/tiers";

export function tierLabel(tier: string | null | undefined): string {
	if (!tier) return "";
	return tier.charAt(0).toUpperCase() + tier.slice(1);
}

interface Invoice {
	id: string;
	created_at: string | null;
	amount: string;
	currency: string;
	status: string;
	description: string;
}

function formatInvoiceDate(iso: string | null): string {
	if (!iso) return "";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
		year: "numeric",
	});
}

/**
 * Shown on a workspace whose billing is handled by its organisation. The
 * workspace shows usage but never a checkout — billing lives one level up, the
 * way DigitalOcean / Anthropic put billing on the account, not each project.
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

/** Full plan comparison: reuses the tier capacity table (single source). */
function PlansModal({
	opened,
	onClose,
	highlightTier,
	period,
	onPeriodChange,
}: {
	opened: boolean;
	onClose: () => void;
	highlightTier: string;
	period: BillingPeriod;
	onPeriodChange: (p: BillingPeriod) => void;
}) {
	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={t`Plans`}
			size="72rem"
			centered
		>
			<Stack gap="md">
				<Group justify="center">
					<BillingPeriodToggle
						value={period}
						onChange={onPeriodChange}
						compact
					/>
				</Group>
				<TierCapacityMatrix
					highlightTier={highlightTier}
					compact={false}
					billingPeriod={period}
				/>
			</Stack>
		</Modal>
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
					data={CANCEL_REASONS.map((r) => ({
						label: r.label,
						value: r.value,
					}))}
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
 * Subscribe-or-manage card for a billing account. Used on the org billing
 * page and on workspace-scoped (bill-separately) workspaces. Handles the
 * return-from-Mollie reconcile, plan comparison, and cancellation.
 */
export function BillingManager({
	accountId,
	currentTier,
	status,
	defaultPeriod = "annual",
	invalidateKeys = [],
	source,
}: {
	accountId: string | null;
	currentTier: string;
	status: string | null;
	defaultPeriod?: BillingPeriod;
	invalidateKeys?: readonly (readonly unknown[])[];
	source: string;
}) {
	const queryClient = useQueryClient();
	// They have a paid plan whenever the tier isn't Free — even if it's
	// "canceled" (still active until the period ends).
	const hasPaidPlan = !!currentTier && currentTier !== "free";
	const isCanceling = status === "canceled";
	const [tier, setTier] = useState<string>(SELLABLE_TIER);
	const [period, setPeriod] = useState<BillingPeriod>(defaultPeriod);
	const [submitting, setSubmitting] = useState(false);
	const [invoices, setInvoices] = useState<Invoice[]>([]);
	const [plansOpen, { open: openPlans, close: closePlans }] =
		useDisclosure(false);
	const [cancelOpen, { open: openCancel, close: closeCancel }] =
		useDisclosure(false);

	const invalidateAll = () => {
		for (const key of invalidateKeys) {
			queryClient.invalidateQueries({ queryKey: key as unknown[] });
		}
	};

	useEffect(() => {
		if (!accountId) return;
		fetch(`${API_BASE_URL}/v2/billing-accounts/${accountId}/invoices`, {
			credentials: "include",
		})
			.then((r) => (r.ok ? r.json() : { invoices: [] }))
			.then((d) => setInvoices(d.invoices ?? []))
			.catch(() => {});
	}, [accountId]);

	// Returning from Mollie checkout: reconcile then refresh.
	useEffect(() => {
		const sp = new URLSearchParams(window.location.search);
		if (sp.get("billing") !== "return" || !accountId) return;
		(async () => {
			try {
				await fetch(`${API_BASE_URL}/v2/billing-accounts/${accountId}/sync`, {
					credentials: "include",
					method: "POST",
				});
				invalidateAll();
				toast.success(t`Subscription updated.`);
			} catch {
				toast.error(t`Could not confirm payment. Refresh to retry.`);
			}
			window.history.replaceState({}, "", window.location.pathname);
		})();
		// biome-ignore lint/correctness/useExhaustiveDependencies: run once on return from checkout
	}, [accountId, invalidateAll]);

	const startCheckout = async (targetTier: string) => {
		if (!accountId || isComingSoon(targetTier)) return;
		setSubmitting(true);
		try {
			posthog.capture("checkout_started", { period, source, tier: targetTier });
			const res = await fetch(
				`${API_BASE_URL}/v2/billing-accounts/${accountId}/checkout`,
				{
					body: JSON.stringify({
						billing_period: period,
						redirect_url: `${window.location.origin}${window.location.pathname}?billing=return`,
						tier: targetTier,
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

	return (
		<Paper withBorder p="md" radius="sm">
			{hasPaidPlan ? (
				<Stack gap={10}>
					<Group justify="space-between" align="center">
						<Text size="sm" fw={500}>
							<Trans>Your plan: {tierLabel(currentTier)}</Trans>
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
						{isCanceling ? (
							<Trans>
								You keep {tierLabel(currentTier)} until your billing period
								ends, then you move to Free.
							</Trans>
						) : (
							<Trans>
								Billed per seat across the organisation. Seat changes are
								prorated.
							</Trans>
						)}
					</Text>
					<Group gap="sm">
						<Button size="xs" variant="subtle" onClick={openPlans}>
							<Trans>See plans</Trans>
						</Button>
						{isCanceling ? (
							<Button
								size="xs"
								loading={submitting}
								onClick={() => startCheckout(currentTier)}
							>
								<Trans>Resume plan</Trans>
							</Button>
						) : (
							<Button
								size="xs"
								variant="subtle"
								color="red"
								onClick={openCancel}
							>
								<Trans>Cancel plan</Trans>
							</Button>
						)}
					</Group>
				</Stack>
			) : (
				<Stack gap={12}>
					<Text size="sm" fw={500}>
						<Trans>Choose a plan</Trans>
					</Text>
					<Text size="xs" c="dimmed">
						<Trans>
							Billed per seat. Every member counts as one seat, counted
							automatically. Cancel anytime.
						</Trans>
					</Text>
					<Group justify="center">
						<BillingPeriodToggle value={period} onChange={setPeriod} compact />
					</Group>
					<TierPricingCards
						value={tier}
						onChange={setTier}
						highlightTier={SELLABLE_TIER}
						billingPeriod={period}
					/>
					<Group justify="flex-end">
						<Button
							loading={submitting}
							disabled={isComingSoon(tier)}
							onClick={() => startCheckout(tier)}
						>
							{isComingSoon(tier) ? (
								<Trans>Coming soon</Trans>
							) : (
								<Trans>Continue to payment</Trans>
							)}
						</Button>
					</Group>
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
				</Stack>
			)}

			{hasPaidPlan && invoices.length > 0 && (
				<Stack gap={6} mt="md">
					<Text size="xs" fw={500} c="dimmed">
						<Trans>Payment history</Trans>
					</Text>
					{invoices.slice(0, 6).map((inv) => (
						<Group key={inv.id} justify="space-between" gap="sm" wrap="nowrap">
							<Text size="xs" c="dimmed">
								{formatInvoiceDate(inv.created_at)}
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
					))}
				</Stack>
			)}

			<PlansModal
				opened={plansOpen}
				onClose={closePlans}
				highlightTier={hasPaidPlan ? currentTier : tier}
				period={period}
				onPeriodChange={setPeriod}
			/>
			<CancelSubscriptionModal
				opened={cancelOpen}
				onClose={closeCancel}
				accountId={accountId}
				currentTier={currentTier}
				source={source}
				onCancelled={invalidateAll}
			/>
		</Paper>
	);
}

interface OrgBilling {
	account_id: string | null;
	tier: string;
	status: string | null;
	billing_period: BillingPeriod | null;
	seats: number;
}

/** Org billing tab body: fetches the org's billing account, then manages it. */
export function OrgBillingTab({ orgId }: { orgId: string }) {
	const { data, isLoading } = useQuery<OrgBilling | null>({
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
			currentTier={data?.tier ?? "free"}
			status={data?.status ?? null}
			defaultPeriod={data?.billing_period ?? "annual"}
			invalidateKeys={[["v2", "orgs", orgId, "billing"]]}
			source="org_billing"
		/>
	);
}
