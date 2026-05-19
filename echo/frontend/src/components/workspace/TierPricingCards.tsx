import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Badge, Box, Divider, Group, Stack, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconCheck } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { API_BASE_URL } from "@/config";
import {
	TIER_BADGE_COLOR,
	TIER_CAPACITY_SHORT,
	type Tier,
	type TierCapacity,
	tierBestFor,
	fetchTierCapacities,
	isTier,
	taglineFor,
} from "@/lib/tiers";
import classes from "./tier-pricing-cards.module.css";

function buildCardData(cap: TierCapacity) {
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
	if (cap.price_eur_monthly != null) {
		priceAmount = `€${cap.price_eur_monthly.toLocaleString("en-IE")}`;
		pricePeriod = t`/mo`;
	} else {
		const note = cap.price_note || t`Custom pricing`;
		const match = note.match(/^(€[\d,]+)\s*(.*)$/);
		if (match) {
			priceAmount = match[1];
			pricePeriod = match[2];
		} else {
			priceAmount = note;
			pricePeriod = "";
		}
	}

	return {
		tier: cap.tier,
		tagline: cap.tagline,
		specs,
		bestFor: tierBestFor(cap.tier),
		priceAmount,
		pricePeriod,
	};
}

function buildFallbackCardData(tier: Tier) {
	const tagline = taglineFor(tier);
	const capacityShort = TIER_CAPACITY_SHORT[tier];
	const specs = capacityShort
		.split(" · ")
		.filter((s) => !s.startsWith("€") || s.includes("seat"));

	let priceAmount = "—";
	let pricePeriod = "";
	const priceMatch = capacityShort.match(/(€[\d,]+(?:\/mo)?|free|custom pricing)/i);
	if (priceMatch) {
		const raw = priceMatch[1];
		if (raw.includes("/mo")) {
			priceAmount = raw.replace("/mo", "");
			pricePeriod = t`/mo`;
		} else {
			priceAmount = raw;
			pricePeriod = "";
		}
	}

	return {
		tier,
		tagline,
		specs,
		bestFor: tierBestFor(tier),
		priceAmount,
		pricePeriod,
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
	highlightLabel: string;
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
			<Stack
				gap={0}
				className={classes.inner}
				style={{ padding: "22px 18px 18px" }}
			>
				<Group gap={8} wrap="nowrap">
					<Text size="lg" style={{ textTransform: "capitalize" }}>
						{card.tier}
					</Text>
					{highlighted && (
						<Badge variant="light" color={TIER_BADGE_COLOR[card.tier as Tier] ?? "blue"} size="xs">
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
						<Group key={spec} gap={7} wrap="nowrap" style={{ lineHeight: 2 }}>
							<IconCheck size={13} stroke={1.5} color="var(--mantine-color-primary-6)" />
							<Text size="xs" c="dimmed">
								{spec}
							</Text>
						</Group>
					))}
				</Stack>
				<Box style={{ marginTop: "auto", paddingTop: 16 }}>
					{card.bestFor && (
						<Text size="xs" c="dimmed" fs="italic" mb={10} lh={1.4}>
							{card.bestFor}
						</Text>
					)}
					<Group gap={3} align="baseline">
						<Text size="xs" c="dimmed">
							<Trans>from</Trans>
						</Text>
						<Text size="xl" style={{ letterSpacing: "-0.02em" }} c="var(--app-text)">
							{card.priceAmount}
						</Text>
						{card.pricePeriod && (
							<Text size="xs" c="dimmed">
								{card.pricePeriod}
							</Text>
						)}
					</Group>
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
	highlightLabel: string;
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
			<Group
				gap={14}
				wrap="nowrap"
				className={classes.inner}
				style={{ padding: "13px 16px" }}
			>
				<Box
					style={{
						width: 15,
						height: 15,
						flexShrink: 0,
						borderRadius: "50%",
						border: `1.5px solid ${selected ? "var(--mantine-color-primary-6)" : "var(--mantine-color-gray-4)"}`,
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
					}}
				>
					{selected && (
						<Box
							style={{
								width: 7,
								height: 7,
								borderRadius: "50%",
								background: "var(--mantine-color-primary-6)",
								transition: "transform 0.15s",
							}}
						/>
					)}
				</Box>
				<div style={{ flex: 1, minWidth: 0 }}>
					<Group gap={6} wrap="nowrap">
						<Text size="sm" c="var(--app-text)" style={{ textTransform: "capitalize" }}>
							{card.tier}
						</Text>
						{highlighted && (
							<Badge variant="light" color={TIER_BADGE_COLOR[card.tier as Tier] ?? "blue"} size="xs">
								{highlightLabel}
							</Badge>
						)}
					</Group>
					<Text size="xs" c="dimmed" mt={2}>
						{capacityLine}
					</Text>
				</div>
				<div style={{ textAlign: "right", flexShrink: 0 }}>
					<Text size="md" c="var(--app-text)" style={{ letterSpacing: "-0.02em" }}>
						{card.priceAmount}
					</Text>
					{card.pricePeriod && (
						<Text size="xs" c="dimmed">
							{card.pricePeriod}
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
	highlightLabel?: string;
	compact?: boolean;
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
	highlightLabel = "Popular",
	compact = false,
}: TierPricingCardsProps) => {
	const isWide = useMediaQuery("(min-width: 768px)");
	const useWideLayout = !compact && isWide;

	const { data: apiData } = useQuery({
		queryKey: ["v2", "tier-capacities"],
		queryFn: () => fetchTierCapacities(API_BASE_URL),
		staleTime: 60 * 60 * 1000,
	});

	const cards: CardData[] = tiers.map((tier) => {
		const apiEntry = apiData?.find((c) => c.tier === tier);
		if (apiEntry) return buildCardData(apiEntry);
		return buildFallbackCardData(tier);
	});

	const CardComponent = useWideLayout ? WideCard : NarrowRow;

	return (
		<div
			style={{
				display: "flex",
				flexDirection: useWideLayout ? "row" : "column",
				flexWrap: useWideLayout ? "wrap" : undefined,
				gap: useWideLayout ? 14 : 8,
			}}
			role="radiogroup"
		>
			{cards.map((card) => (
				<CardComponent
					key={card.tier}
					card={card}
					selected={value === card.tier}
					highlighted={card.tier === highlightTier}
					highlightLabel={highlightLabel}
					onSelect={() => onChange(card.tier)}
				/>
			))}
		</div>
	);
};
