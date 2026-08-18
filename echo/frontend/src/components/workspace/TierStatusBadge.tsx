import { Trans } from "@lingui/react/macro";
import { Badge } from "@mantine/core";
import type { ReactNode } from "react";
import { resolveTierBadge, TIER_BADGE_COLOR, type Tier } from "@/lib/tiers";

type TierStatusBadgeProps = {
	tier: string;
	/** Override which tier is "popular". Defaults to SELLABLE_TIER. */
	popularTier?: string | null;
	/** Label for the popular badge. Defaults to "Popular". */
	popularLabel?: ReactNode;
};

// Single status badge (coming-soon / new / popular) shared by the pricing cards
// and the capacity matrix, so the state stays consistent across surfaces.
export const TierStatusBadge = ({
	tier,
	popularTier,
	popularLabel,
}: TierStatusBadgeProps) => {
	const kind = resolveTierBadge(
		tier,
		popularTier === undefined ? undefined : { popularTier },
	);

	if (kind === "coming-soon") {
		return (
			<Badge variant="filled" color="graphite" size="xs">
				<Trans>Coming soon</Trans>
			</Badge>
		);
	}

	if (kind === "new") {
		return (
			<Badge variant="light" color="green" size="xs">
				<Trans>New</Trans>
			</Badge>
		);
	}

	if (kind === "popular") {
		return (
			<Badge
				variant="light"
				color={TIER_BADGE_COLOR[tier as Tier] ?? "primary"}
				size="xs"
			>
				{popularLabel ?? <Trans>Popular</Trans>}
			</Badge>
		);
	}

	return null;
};
