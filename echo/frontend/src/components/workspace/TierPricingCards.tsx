import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Badge, Box, Divider, Group, Stack, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconCheck } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { API_BASE_URL } from "@/config";
import {
	type BillingPeriod,
	capacityShortFor,
	fetchTierCapacities,
	isTier,
	pricingForBillingPeriod,
	TIER_BADGE_COLOR,
	type Tier,
	type TierCapacity,
	taglineFor,
	tierBestFor,
} from "@/lib/tiers";
import classes from "./tier-pricing-cards.module.css";

function buildCardData(cap: TierCapacity, billingPeriod: BillingPeriod) {
	const specs: string[] = [];
	if (cap.included_seats == null) {
		specs.push(t`Unlimited seats`);
	} else {
		specs.push(t`${cap.included_seats} seats included`);
	}
	if (cap.included_hours == null) {
		specs.push(t`Unlimited hours`);
	} else if (cap.duration === "one-time") {
		specs.push(t`${cap.included_hours} hours total`);
	} else {
		specs.push(t`${cap.included_hours} hours / month`);
	}
	if (cap.seat_overage_eur != null) {
		specs.push(t`€${cap.seat_overage_eur} / extra seat`);
	} else if (cap.included_seats == null) {
		specs.push(t`Dedicated support`);
	}

	let priceAmount: string;
	let pricePeriod: string;
	let priceSubtext = "";

	const resolved = pricingForBillingPeriod(cap, billingPeriod);
	if (resolved?.kind === "annual") {
		priceAmount = `€${resolved.per_month_eur.toLocaleString("en-IE")}`;
		pricePeriod = t`/mo`;
		const total = `€${resolved.total_per_year_eur.toLocaleString("en-IE")}`;
		priceSubtext = t`billed annually · ${total}/yr`;
	} else if (resolved?.kind === "monthly") {
		priceAmount = `€${resolved.per_month_eur.toLocaleString("en-IE")}`;
		pricePeriod = t`/mo`;
		priceSubtext = t`billed monthly`;
	} else if (resolved?.kind === "one_time") {
		priceAmount = `€${resolved.amount_eur.toLocaleString("en-IE")}`;
		pricePeriod = t`one-time`;
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
	} else if (tier === "pilot") {
		priceAmount = "€349";
		pricePeriod = t`one-time`;
	} else {
		// Pioneer+. Fallback hard-codes the annual-billing rates so the
		// component still renders if the network call hasn't returned.
		const annualPerMonth: Record<string, number> = {
			changemaker: 1500,
			guardian: 5000,
			innovator: 500,
			pioneer: 200,
		};
		const base = annualPerMonth[tier] ?? 0;
		const value = billingPeriod === "monthly" ? Math.round(base * 1.1) : base;
		priceAmount = `€${value.toLocaleString("en-IE")}`;
		pricePeriod = t`/mo`;
		if (billingPeriod === "annual") {
			const total = `€${(base * 12).toLocaleString("en-IE")}`;
			priceSubtext = t`billed annually · ${total}/yr`;
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

function WideCard({
	card,
	selected,
	highlighted,
	highlightLabel,
	onSelect,
}: {
	card: CardData;
	selected: boolean;
	highlighted: boolean;
	highlightLabel: ReactNode;
	onSelect: () => void;
}) {
	return (
		<div
			className={`${classes.wideWrap} ${selected ? classes.selected : ""}`}
			onClick={onSelect}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onSelect();
				}
			}}
			role="radio"
			aria-checked={selected}
			tabIndex={0}
		>
			<Stack gap={0} className={classes.wideInner}>
				<Group gap={8} wrap="nowrap">
					<Text size="lg" className={classes.tierName}>
						{card.tier}
					</Text>
					{highlighted && (
						<Badge
							variant="light"
							color={TIER_BADGE_COLOR[card.tier as Tier] ?? "blue"}
							size="xs"
						>
							{highlightLabel}
						</Badge>
					)}
				</Group>
				<Text size="xs" c="dimmed" mt={4}>
					{card.tagline}
				</Text>
				<Divider my={14} color="var(--mantine-color-gray-2)" />
				<Stack gap={0}>
					{card.specs.map((spec) => (
						<Group key={spec} gap={7} wrap="nowrap" className={classes.specRow}>
							<IconCheck
								size={13}
								stroke={1.5}
								color="var(--mantine-color-primary-6)"
							/>
							<Text size="xs" c="dimmed">
								{spec}
							</Text>
						</Group>
					))}
				</Stack>
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
						<Text size="xl" className={classes.priceAmount} c="var(--app-text)">
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

function NarrowRow({
	card,
	selected,
	highlighted,
	highlightLabel,
	onSelect,
}: {
	card: CardData;
	selected: boolean;
	highlighted: boolean;
	highlightLabel: ReactNode;
	onSelect: () => void;
}) {
	const capacityLine = card.specs.slice(0, 2).join(" · ");

	return (
		<div
			className={`${classes.wrap} ${selected ? classes.selected : ""}`}
			onClick={onSelect}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onSelect();
				}
			}}
			role="radio"
			aria-checked={selected}
			tabIndex={0}
		>
			<Group gap={14} wrap="nowrap" className={classes.narrowInner}>
				<Box className={selected ? classes.radioSelected : classes.radio}>
					{selected && <Box className={classes.radioDot} />}
				</Box>
				<div className={classes.narrowMain}>
					<Group gap={6} wrap="nowrap">
						<Text size="sm" c="var(--app-text)" className={classes.tierName}>
							{card.tier}
						</Text>
						{highlighted && (
							<Badge
								variant="light"
								color={TIER_BADGE_COLOR[card.tier as Tier] ?? "blue"}
								size="xs"
							>
								{highlightLabel}
							</Badge>
						)}
					</Group>
					<Text size="xs" c="dimmed" mt={2}>
						{capacityLine}
					</Text>
				</div>
				<div className={classes.narrowPrice}>
					<Text size="md" c="var(--app-text)" className={classes.priceAmount}>
						{card.priceAmount}
					</Text>
					{card.pricePeriod && (
						<Text size="xs" c="dimmed">
							{card.pricePeriod}
						</Text>
					)}
					{card.priceSubtext && (
						<Text size="xs" c="dimmed">
							{card.priceSubtext}
						</Text>
					)}
				</div>
			</Group>
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

const REQUESTABLE_TIERS: Tier[] = [
	"pilot",
	"pioneer",
	"innovator",
	"changemaker",
	"guardian",
];

export const TierPricingCards = ({
	tiers = REQUESTABLE_TIERS,
	value,
	onChange,
	highlightTier = "innovator",
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

	const CardComponent = useWideLayout ? WideCard : NarrowRow;
	const resolvedHighlightLabel = highlightLabel ?? <Trans>Popular</Trans>;

	return (
		<div
			className={useWideLayout ? classes.groupWide : classes.group}
			role="radiogroup"
		>
			{cards.map((card) => (
				<CardComponent
					key={card.tier}
					card={card}
					selected={value === card.tier}
					highlighted={card.tier === highlightTier}
					highlightLabel={resolvedHighlightLabel}
					onSelect={() => onChange(card.tier)}
				/>
			))}
		</div>
	);
};
