import { t } from "@lingui/core/macro";
import type { MantineSize } from "@mantine/core";
import { Badge, Group, Stack, Text, Tooltip } from "@mantine/core";
import { capacityShortFor, taglineFor } from "@/lib/tiers";

// One colour per tier, shared by every tier badge. A tier is context, not a
// status or an action, so each reads as a neutral tag.
export const TIER_COLOR: Record<string, string> = {
	changemaker: "gray",
	free: "gray",
	guardian: "gray",
	innovator: "gray",
	pilot: "gray",
	pioneer: "gray",
};

export const tierColor = (tier: string): string => TIER_COLOR[tier] ?? "gray";

/** The tier's display name: "innovator" reads "Innovator". */
export const tierName = (tier: string): string =>
	tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : "";

interface TierBadgeProps {
	tier: string;
	size?: MantineSize;
	/** When true, render the tagline inline next to the badge. Use on
	 * surfaces with enough width. Defaults to false (tagline via tooltip). */
	showTagline?: boolean;
	/** True when the workspace bills on its own (workspace-scoped) account
	 * rather than the org's pooled plan — appends "(Partner)" to the tier. */
	billsSeparately?: boolean;
}

/**
 * Tier badge with pairing tagline (matrix v1.1 §1).
 *
 * Two render modes:
 * - Inline (`showTagline=true`): badge + "— tagline" text after it. Use
 *   on detail pages and selector cards where space allows.
 * - Tooltip (default): badge alone; the tagline is in a tooltip. Use on
 *   compact rows (matrix cells, header chips) where a second line of
 *   copy would be visual clutter.
 *
 * Either way, the tagline is never absent — matrix requires pairing.
 */
export const TierBadge = ({
	tier,
	size = "sm",
	showTagline = false,
	billsSeparately = false,
}: TierBadgeProps) => {
	const tagline = taglineFor(tier);
	const capacity = capacityShortFor(tier);

	const badge = (
		<Badge size={size} variant="light" color={tierColor(tier)}>
			{billsSeparately ? t`${tierName(tier)} (partner)` : tierName(tier)}
		</Badge>
	);

	// Tooltip always shows tagline + capacity so every surface answers
	// "what does this tier get me?" without leaving the page. The partner line
	// clarifies that this workspace bills on its own, not the org's plan.
	const tooltipLabel =
		tagline || capacity || billsSeparately ? (
			<Stack gap="xs">
				{tagline && <Text size="xs">{tagline}</Text>}
				{capacity && (
					<Text size="xs" c="dimmed">
						{capacity}
					</Text>
				)}
				{billsSeparately && (
					<Text size="xs" c="dimmed">
						{t`Billed separately, not part of the organisation's plan.`}
					</Text>
				)}
			</Stack>
		) : null;

	if (showTagline && tagline) {
		return (
			<Tooltip label={tooltipLabel} disabled={!tooltipLabel}>
				<Group gap="xs" wrap="nowrap">
					{badge}
					<Text size="xs" c="dimmed">
						· {tagline}
					</Text>
				</Group>
			</Tooltip>
		);
	}

	if (tooltipLabel) {
		return <Tooltip label={tooltipLabel}>{badge}</Tooltip>;
	}

	return badge;
};
