import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Box, Collapse, Divider, Group, Stack, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconCheck } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import type { KeyboardEvent, ReactNode } from "react";
import { API_BASE_URL } from "@/config";
import {
	type BillingPeriod,
	capacityShortFor,
	fetchTierCapacities,
	isComingSoon,
	isTier,
	MONTHLY_BILLING_PREMIUM_PCT,
	PURCHASABLE_TIERS,
	pricingForBillingPeriod,
	TIER_FALLBACK_PRICE_EUR,
	type Tier,
	type TierCapacity,
	taglineFor,
	tierBestFor,
} from "@/lib/tiers";
import { TierStatusBadge } from "./TierStatusBadge";
import classes from "./tier-pricing-cards.module.css";

function buildCardData(cap: TierCapacity, billingPeriod: BillingPeriod) {
	const specs: string[] = [];
	// No "unlimited seats" line — billing is per user, so seats aren't a cap.
	if (cap.included_seats != null) {
		specs.push(t`${cap.included_seats} seats included`);
	}
	if (cap.included_hours == null) {
		specs.push(t`Unlimited hours`);
	} else if (!cap.billing_period_applicable) {
		specs.push(t`${cap.included_hours} hours total`);
	} else {
		specs.push(t`${cap.included_hours} hours / month`);
	}
	if (cap.training_included && cap.training_included !== "—") {
		specs.push(t`Training: ${cap.training_included}`);
	}
	// Innovator intentionally omits the dedicated-support line for now.
	if (cap.included_seats == null && cap.tier !== "innovator") {
		specs.push(t`Dedicated support`);
	}

	let priceAmount: string;
	let pricePeriod: string;
	let priceSubtext = "";

	const resolved = pricingForBillingPeriod(cap, billingPeriod);
	if (resolved?.kind === "annual") {
		priceAmount = `€${resolved.per_month_eur.toLocaleString("en-IE")}`;
		pricePeriod = t`/seat/mo`;
		const total = `€${resolved.total_per_year_eur.toLocaleString("en-IE")}`;
		priceSubtext = t`billed annually · ${total}/seat/yr`;
	} else if (resolved?.kind === "monthly") {
		priceAmount = `€${resolved.per_month_eur.toLocaleString("en-IE")}`;
		pricePeriod = t`/seat/mo`;
		priceSubtext = t`billed monthly`;
	} else {
		priceAmount = t`Free`;
		pricePeriod = "";
	}

	return {
		bestFor: tierBestFor(cap.tier),
		priceAmount,
		pricePeriod,
		priceSubtext,
		specs,
		tagline: isTier(cap.tier) ? taglineFor(cap.tier) : cap.tagline,
		tier: cap.tier,
	};
}

function buildFallbackCardData(tier: Tier, billingPeriod: BillingPeriod) {
	const tagline = taglineFor(tier);
	const capacityShort = capacityShortFor(tier);
	const specs = capacityShort
		.split(" · ")
		.filter((s) => !s.startsWith("€") || s.includes("seat"));

	let priceAmount = "—";
	let pricePeriod = "";
	let priceSubtext = "";

	if (tier === "free") {
		priceAmount = t`Free`;
	} else {
		// Paid tiers. The fallback per-seat rates live in TIER_FALLBACK_PRICE_EUR
		// (one place) so the component still renders before the API call returns.
		const base = TIER_FALLBACK_PRICE_EUR[tier] ?? 0;
		const value =
			billingPeriod === "monthly"
				? Math.round(base * (1 + MONTHLY_BILLING_PREMIUM_PCT / 100))
				: base;
		priceAmount = `€${value.toLocaleString("en-IE")}`;
		pricePeriod = t`/seat/mo`;
		if (billingPeriod === "annual") {
			const total = `€${(base * 12).toLocaleString("en-IE")}`;
			priceSubtext = t`billed annually · ${total}/seat/yr`;
		} else {
			priceSubtext = t`billed monthly`;
		}
	}

	return {
		bestFor: tierBestFor(tier),
		priceAmount,
		pricePeriod,
		priceSubtext,
		specs,
		tagline,
		tier,
	};
}

type CardData = ReturnType<typeof buildCardData>;

type CardLayout = "wide" | "mobile";

function TierCard({
	card,
	layout,
	selected,
	highlighted,
	highlightTier,
	highlightLabel,
	comingSoon,
	onSelect,
}: {
	card: CardData;
	layout: CardLayout;
	selected: boolean;
	highlighted: boolean;
	highlightTier?: string | null;
	highlightLabel: ReactNode;
	comingSoon: boolean;
	onSelect: () => void;
}) {
	const isWide = layout === "wide";
	const wrapClasses = [
		isWide ? classes.wideWrap : classes.wrap,
		selected ? classes.selected : "",
		highlighted && !comingSoon ? classes.highlighted : "",
		comingSoon ? classes.comingSoonCard : "",
	]
		.filter(Boolean)
		.join(" ");

	const handleKeyDown = (e: KeyboardEvent) => {
		if (!comingSoon && (e.key === "Enter" || e.key === " ")) {
			e.preventDefault();
			onSelect();
		}
	};

	// Shared badge + spec list — the only parts that were duplicated between
	// the wide and mobile layouts.
	const badge = (
		<TierStatusBadge
			tier={card.tier}
			popularTier={highlightTier}
			popularLabel={highlightLabel}
		/>
	);
	// Coming-soon cards mute content per element instead of fading the card,
	// so the "Coming soon" badge keeps full contrast.
	const mutedText = comingSoon ? "gray.6" : undefined;
	const specRows = card.specs.map((spec) => (
		<Group key={spec} gap={7} wrap="nowrap" className={classes.specRow}>
			<IconCheck
				size={isWide ? 13 : 14}
				stroke={1.5}
				color={
					comingSoon
						? "var(--mantine-color-gray-5)"
						: "var(--mantine-color-primary-6)"
				}
			/>
			<Text size={isWide ? "xs" : "sm"} c="dimmed">
				{spec}
			</Text>
		</Group>
	));

	if (isWide) {
		return (
			// biome-ignore lint/a11y/useSemanticElements: card-as-radio; the entire card is the click target
			<div
				className={wrapClasses}
				onClick={comingSoon ? undefined : onSelect}
				onKeyDown={handleKeyDown}
				role="radio"
				aria-checked={selected}
				aria-disabled={comingSoon}
				tabIndex={comingSoon ? -1 : 0}
			>
				<Stack gap={0} className={classes.wideInner}>
					<Group gap={8} wrap="nowrap">
						<Text size="lg" className={classes.tierName} c={mutedText}>
							{card.tier}
						</Text>
						{badge}
					</Group>
					<Text size="xs" c="dimmed" mt={4}>
						{card.tagline}
					</Text>
					<Divider my={14} color="var(--mantine-color-gray-2)" />
					<Stack gap={0}>{specRows}</Stack>
					<Box className={classes.priceFooter}>
						{card.bestFor && (
							<Text size="xs" c="dimmed" fs="italic" mb={10} lh={1.4}>
								{card.bestFor}
							</Text>
						)}
						<Group gap={3} align="baseline">
							<Text size="xs" c="dimmed">
								<Trans>from</Trans>
							</Text>
							<Text
								size="xl"
								className={classes.priceAmount}
								c={mutedText ?? "var(--app-text)"}
							>
								{card.priceAmount}
							</Text>
							{card.pricePeriod && (
								<Text size="xs" c="dimmed">
									{card.pricePeriod}
								</Text>
							)}
						</Group>
						{card.priceSubtext && (
							<Text size="xs" c="dimmed" mt={2}>
								{card.priceSubtext}
							</Text>
						)}
					</Box>
				</Stack>
			</div>
		);
	}

	return (
		// biome-ignore lint/a11y/useSemanticElements: card-as-radio; the entire card is the click target
		<div
			className={wrapClasses}
			onClick={comingSoon ? undefined : onSelect}
			onKeyDown={handleKeyDown}
			role="radio"
			aria-checked={selected}
			aria-disabled={comingSoon}
			tabIndex={comingSoon ? -1 : 0}
		>
			<Stack gap={0} className={classes.mobileInner}>
				<Group
					justify="space-between"
					wrap="nowrap"
					align="flex-start"
					gap={12}
				>
					<Group gap={8} wrap="nowrap">
						<Text size="md" fw={500} className={classes.tierName} c={mutedText}>
							{card.tier}
						</Text>
						{badge}
					</Group>
					<Stack gap={2} align="flex-end">
						<Group gap={3} align="baseline" wrap="nowrap">
							<Text
								size="lg"
								className={classes.priceAmount}
								c={mutedText ?? "var(--app-text)"}
							>
								{card.priceAmount}
							</Text>
							{card.pricePeriod && (
								<Text size="xs" c="dimmed">
									{card.pricePeriod}
								</Text>
							)}
						</Group>
						{card.priceSubtext && (
							<Text size="xs" c="dimmed" ta="right" lh={1.3}>
								{card.priceSubtext}
							</Text>
						)}
					</Stack>
				</Group>

				<Collapse in={selected}>
					<Stack gap={10} pt={14}>
						<Text size="xs" c="dimmed">
							{card.tagline}
						</Text>
						<Divider color="var(--mantine-color-gray-2)" />
						<Stack gap={0}>{specRows}</Stack>
						{card.bestFor && (
							<Text size="xs" c="dimmed" fs="italic" lh={1.4}>
								{card.bestFor}
							</Text>
						)}
					</Stack>
				</Collapse>
			</Stack>
		</div>
	);
}

interface TierPricingCardsProps {
	tiers?: Tier[];
	value: string | null;
	onChange: (tier: string) => void;
	highlightTier?: string | null;
	highlightLabel?: ReactNode;
	compact?: boolean;
	/** Active billing cadence. Defaults to "annual" for callers that haven't
	 *  wired the toggle yet — preserves today's prices on first paint. */
	billingPeriod?: BillingPeriod;
}

// Free is hidden from selection (see VISIBLE_TIERS in lib/tiers).
const REQUESTABLE_TIERS: Tier[] = ["innovator", "changemaker", "guardian"];

export const TierPricingCards = ({
	tiers = REQUESTABLE_TIERS,
	value,
	onChange,
	highlightTier = "changemaker",
	highlightLabel,
	compact = false,
	billingPeriod = "annual",
}: TierPricingCardsProps) => {
	const isWide = useMediaQuery("(min-width: 768px)");
	const useWideLayout = !compact && isWide;

	const { data: apiData } = useQuery({
		queryFn: () => fetchTierCapacities(API_BASE_URL),
		queryKey: ["v2", "tier-capacities"],
		staleTime: 60 * 60 * 1000,
	});

	const cards: CardData[] = tiers.map((tier) => {
		const apiEntry = apiData?.find((c) => c.tier === tier);
		if (apiEntry) return buildCardData(apiEntry, billingPeriod);
		return buildFallbackCardData(tier, billingPeriod);
	});

	const resolvedHighlightLabel = highlightLabel ?? <Trans>Popular</Trans>;

	// ISSUE-011: a "Popular" badge on the sole buyable plan reads oddly, so hide
	// it while exactly one tier is purchasable. It auto-restores once a second
	// tier ships (PURCHASABLE_TIERS derives from the coming-soon list). Only the
	// badge is suppressed; the card's visual highlight stays.
	const badgePopularTier = PURCHASABLE_TIERS.length >= 2 ? highlightTier : null;

	return (
		<Stack gap={16}>
			<div
				className={useWideLayout ? classes.groupWide : classes.group}
				role="radiogroup"
			>
				{cards.map((card) => (
					<TierCard
						key={card.tier}
						card={card}
						layout={useWideLayout ? "wide" : "mobile"}
						selected={value === card.tier}
						highlighted={card.tier === highlightTier}
						highlightTier={badgePopularTier}
						highlightLabel={resolvedHighlightLabel}
						comingSoon={isComingSoon(card.tier)}
						onSelect={() => onChange(card.tier)}
					/>
				))}
			</div>
			<Text size="xs" c="dimmed" ta="center">
				<Trans>
					Interested in innovator or guardian? Let us know via{" "}
					<a
						href="http://forms.dembrane.com/contact"
						target="_blank"
						rel="noopener noreferrer"
						style={{ color: "inherit", textDecoration: "underline" }}
					>
						forms.dembrane.com/contact
					</a>
				</Trans>
			</Text>
		</Stack>
	);
};
