import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Anchor,
	Avatar,
	Badge,
	Box,
	Button,
	Group,
	Modal,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import { IconLock } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import posthog from "posthog-js";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "@/components/common/Toaster";
import { BillingPeriodToggle } from "@/components/workspace/BillingPeriodToggle";
import { TierPricingCards } from "@/components/workspace/TierPricingCards";
import { API_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useWorkspace } from "@/hooks/useWorkspace";
import { avatarUrl } from "@/lib/avatar";
import { emitFrozenFeatureAttempt } from "@/lib/frozenFeatureAttempt";
import {
	type BillingPeriod,
	TIER_ORDER,
	type Tier,
	taglineFor,
} from "@/lib/tiers";

/**
 * Tier-gating UI primitives for the ECHO platform.
 *
 * Locks in the designer's Ask 4 decisions (D9, D20):
 *   - Gate affordance = modal only, no hover tooltip (hover reads as
 *     marketing pressure).
 *   - Role-aware: admin/owner sees "Request upgrade" primary. Member
 *     sees no primary CTA — only dismiss ("ask a organisation admin" is the
 *     message, not a button).
 *   - "dembrane" lowercase, no "AI", no "successfully" per brand rules.
 *
 * Exports:
 *   - <FeatureGate /> — hatched overlay for whole feature surfaces (4B)
 *   - <UpgradeModal />  — one-feature, one-CTA modal (4C), usable standalone
 *   - requiredTierCopy  — shared "This feature requires X plan" text
 */

interface FeatureGateProps {
	/** Currently-resolved workspace tier. */
	currentTier: Tier;
	/** Minimum tier the wrapped feature requires. */
	requiredTier: Tier;
	/** "Whitelabel branding" / "Data export" / "API access" etc. */
	featureName: string;
	/** One-line benefit sentence. */
	benefit: string;
	/** `true` if the caller has admin/owner role in this workspace. */
	canRequestUpgrade: boolean;
	/** Workspace id for the tier_upgrade request. */
	workspaceId: string;
	/** The gated feature's normal render — shown under the hatched overlay. */
	children: ReactNode;
}

function meetsTier(current: Tier, required: Tier): boolean {
	return TIER_ORDER.indexOf(current) >= TIER_ORDER.indexOf(required);
}

/**
 * Wraps a feature card with a hatched overlay when the tier doesn't meet
 * the minimum. The entire card becomes a click target that opens the
 * upgrade modal. If the tier is already met, renders children as-is.
 */
export function FeatureGate({
	currentTier,
	requiredTier,
	featureName,
	benefit,
	canRequestUpgrade,
	workspaceId,
	children,
}: FeatureGateProps) {
	const [modalOpen, setModalOpen] = useState(false);

	if (meetsTier(currentTier, requiredTier)) {
		return <>{children}</>;
	}

	// Deliberately do NOT render children when gated. `pointer-events: none`
	// was a tempting dimming trick but doesn't stop keyboard-level event
	// listeners, async code paths, or focus-trap components inside the
	// gated subtree (round-2 audit, Security M1). The only safe boundary
	// is "don't mount the feature at all when the tier doesn't meet" —
	// render just the gate placeholder card.
	// Matrix §3: attempting a frozen feature re-shows the post-downgrade
	// banner if it was dismissed. We fire on every gate-open; DowngradeBanner
	// only reacts when the current workspace has an active downgrade, so this
	// is a cheap no-op on never-downgraded workspaces.
	const openModal = () => {
		emitFrozenFeatureAttempt();
		setModalOpen(true);
	};

	return (
		<>
			<Box
				pos="relative"
				onClick={openModal}
				style={{
					alignItems: "center",
					// Soft hatched background — subtle, not alarming.
					background:
						"repeating-linear-gradient(45deg, rgba(65,105,225,0.04) 0 8px, rgba(65,105,225,0.08) 8px 16px)",
					borderRadius: 8,
					cursor: "pointer",
					display: "flex",
					justifyContent: "center",
					minHeight: 160,
				}}
				role="button"
				tabIndex={0}
				aria-label={`${featureName} · requires ${requiredTier} plan`}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						openModal();
					}
				}}
			>
				<Stack gap={6} align="center" style={{ maxWidth: 280 }} p="md">
					<Badge
						color="blue"
						variant="light"
						leftSection={<IconLock size={12} />}
					>
						{requiredTier}
					</Badge>
					<Text size="sm" ta="center" fw={500}>
						{featureName}
					</Text>
					<Text size="sm" ta="center" c="dimmed" fw={400}>
						{benefit}
					</Text>
				</Stack>
			</Box>
			<UpgradeModal
				opened={modalOpen}
				onClose={() => setModalOpen(false)}
				currentTier={currentTier}
				requiredTier={requiredTier}
				featureName={featureName}
				benefit={benefit}
				canRequestUpgrade={canRequestUpgrade}
				workspaceId={workspaceId}
			/>
		</>
	);
}

interface UpgradeModalProps {
	opened: boolean;
	onClose: () => void;
	currentTier: Tier;
	requiredTier: Tier;
	featureName: string;
	benefit: string;
	/** Admin/owner sees Request Upgrade. Member sees message-only per D9. */
	canRequestUpgrade: boolean;
	workspaceId: string;
}

/**
 * Ask 4C — one feature, one benefit, one tier, one CTA.
 *
 * Admin path: "Request upgrade" posts to /v2/workspace-requests (kind=tier_upgrade).
 * Member path: informational only; the copy says "ask a organisation admin" but
 * there's no button — Q3 decision (D9). Keeping the message honest:
 * there's nothing we can do for them, only their admin can.
 */
interface OrganisationAdminRow {
	user_id: string;
	display_name: string | null;
	avatar: string | null;
	role: string;
}

/**
 * Renders the matrix §11 member-path copy with actual admin faces +
 * names so "ask a organisation admin" is concrete, not abstract.
 *
 * Silent fallback to the generic message if the org lookup fails — no
 * broken state.
 */
function OrganisationAdminChips() {
	const { workspace } = useWorkspace();
	const orgId = workspace?.org_id;

	const { data } = useQuery({
		enabled: Boolean(orgId),
		queryFn: async (): Promise<OrganisationAdminRow[]> => {
			if (!orgId) return [];
			const res = await fetch(`${API_BASE_URL}/v2/orgs/${orgId}/members`, {
				credentials: "include",
			});
			if (!res.ok) return [];
			const rows = (await res.json()) as OrganisationAdminRow[];
			return Array.isArray(rows)
				? rows.filter((r) => r.role === "admin" || r.role === "owner")
				: [];
		},
		queryKey: ["v2", "organisation-admins", orgId],
		staleTime: 5 * 60 * 1000,
	});

	const admins = data ?? [];
	if (admins.length === 0) {
		// Fallback — generic message when we can't resolve the admin list.
		return (
			<Text size="sm" c="dimmed">
				<Trans>
					A organisation admin can request this upgrade. Ask someone with the
					admin role.
				</Trans>
			</Text>
		);
	}

	const firstThree = admins.slice(0, 3);
	const names = firstThree
		.map((a) => a.display_name || t`a organisation admin`)
		.join(", ");
	const more =
		admins.length > firstThree.length
			? ` +${admins.length - firstThree.length}`
			: "";

	return (
		<Stack gap={6}>
			<Text size="sm" c="dimmed">
				<Trans>Ask a organisation admin to request this upgrade.</Trans>
			</Text>
			<Group gap={6}>
				<Avatar.Group spacing="sm">
					{firstThree.map((a) => (
						<Tooltip
							key={a.user_id}
							label={a.display_name || t`organisation admin`}
						>
							<Avatar
								src={avatarUrl(a.avatar)}
								name={a.display_name || "?"}
								color="blue"
								size={28}
								radius="xl"
							/>
						</Tooltip>
					))}
				</Avatar.Group>
				<Text size="xs" c="dimmed">
					{names}
					{more}
				</Text>
			</Group>
		</Stack>
	);
}

export function UpgradeModal({
	opened,
	onClose,
	currentTier,
	requiredTier,
	featureName,
	benefit,
	canRequestUpgrade,
}: UpgradeModalProps) {
	const { workspace } = useWorkspace();
	const navigate = useI18nNavigate();
	const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>("annual");

	const tiersAboveCurrent = TIER_ORDER.filter(
		(t) => TIER_ORDER.indexOf(t) > TIER_ORDER.indexOf(currentTier),
	);
	const defaultSelectedTier = tiersAboveCurrent.includes(requiredTier)
		? requiredTier
		: (tiersAboveCurrent[0] ?? requiredTier);
	const [selectedTier, setSelectedTier] = useState<Tier>(defaultSelectedTier);

	useEffect(() => {
		if (opened) setSelectedTier(defaultSelectedTier);
	}, [opened, defaultSelectedTier]);

	// Funnel start: pairs with upgrade_billing_opened below, so PostHog can
	// show conversion and time-to-upgrade per gated feature.
	useEffect(() => {
		if (opened) {
			posthog.capture("upgrade_prompt_viewed", {
				can_request_upgrade: canRequestUpgrade,
				current_tier: currentTier,
				feature_name: featureName,
				required_tier: requiredTier,
			});
		}
	}, [opened, canRequestUpgrade, currentTier, featureName, requiredTier]);

	const goToBilling = () => {
		if (!workspace?.org_id) {
			toast.error(t`Workspace data not loaded yet. Please try again.`);
			return;
		}
		posthog.capture("upgrade_billing_opened", {
			feature_name: featureName,
			proposed_tier: selectedTier,
		});
		onClose();
		// Billing is managed at the organisation level; send them there to pick
		// a plan and pay. Self-serve replaced the staff request flow.
		navigate(`/o/${workspace.org_id}/settings/billing`);
	};

	const displayTier = canRequestUpgrade ? selectedTier : requiredTier;
	const displayName = canRequestUpgrade
		? t`Upgrade to ${displayTier}`
		: featureName;
	const displayBenefit = canRequestUpgrade
		? taglineFor(displayTier) || benefit
		: benefit;

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={<Text fw={500}>{displayName}</Text>}
			centered
			size="72rem"
		>
			<Stack gap="md">
				<Text size="sm" c="dimmed">
					{displayBenefit}
				</Text>

				<Group gap={8} align="center">
					<Text size="sm" c="dimmed">
						<Trans>Your current plan</Trans>
					</Text>
					<Badge variant="light" tt="capitalize">
						{currentTier}
					</Badge>
				</Group>

				{canRequestUpgrade ? (
					<>
						<Group justify="center" mb="xs">
							<BillingPeriodToggle
								value={billingPeriod}
								onChange={setBillingPeriod}
								compact
							/>
						</Group>
						<TierPricingCards
							tiers={tiersAboveCurrent}
							value={selectedTier}
							onChange={(tier) => setSelectedTier(tier as Tier)}
							billingPeriod={billingPeriod}
						/>
						<Text size="xs" c="dimmed">
							<Trans>
								Billed per seat across the organisation. Cancel anytime.
								Scholarships are available for eligible organisations: email{" "}
								<Anchor href="mailto:support@dembrane.com">
									support@dembrane.com
								</Anchor>
								.
							</Trans>
						</Text>
					</>
				) : (
					<>
						<Group justify="center" mb="xs">
							<BillingPeriodToggle
								value={billingPeriod}
								onChange={setBillingPeriod}
								compact
							/>
						</Group>
						<TierPricingCards
							tiers={tiersAboveCurrent}
							value={requiredTier}
							onChange={() => {}}
							billingPeriod={billingPeriod}
						/>
						<OrganisationAdminChips />
					</>
				)}

				<Text size="xs" c="dimmed">
					<Trans>
						Teams in the EU using dembrane in scenarios classified as high risk
						under the EU AI Act must complete a training before using their
						workspace.
					</Trans>{" "}
					<Anchor
						href="https://www.dembrane.com/platform/pricing#training"
						target="_blank"
						rel="noopener noreferrer"
						inherit
					>
						<Trans>Learn more</Trans>
					</Anchor>
				</Text>

				<Box style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
					<Button variant="subtle" onClick={onClose}>
						<Trans>Close</Trans>
					</Button>
					{canRequestUpgrade && (
						<Button onClick={goToBilling}>
							<Trans>Go to billing</Trans>
						</Button>
					)}
				</Box>
			</Stack>
		</Modal>
	);
}
