import type { MantineSize } from "@mantine/core";
import { Badge, Group, Stack, Text, Tooltip } from "@mantine/core";
import { capacityShortFor, taglineFor } from "@/lib/tiers";

interface TierBadgeProps {
	tier: string;
	size?: MantineSize;
	/** When true, render the tagline inline next to the badge. Use on
	 * surfaces with enough width. Defaults to false (tagline via tooltip). */
	showTagline?: boolean;
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
}: TierBadgeProps) => {
	const tagline = taglineFor(tier);
	const capacity = capacityShortFor(tier);

	const badge = (
		<Badge
			size={size}
			variant="light"
			color="blue"
			style={{ textTransform: "capitalize" }}
		>
			{tier}
		</Badge>
	);

	// Tooltip always shows tagline + capacity so every surface answers
	// "what does this tier get me?" without leaving the page.
	const tooltipLabel =
		tagline || capacity ? (
			<Stack gap={2}>
				{tagline && <Text size="xs">{tagline}</Text>}
				{capacity && (
					<Text size="xs" c="dimmed">
						{capacity}
					</Text>
				)}
			</Stack>
		) : null;

	if (showTagline && tagline) {
		return (
			<Tooltip label={tooltipLabel} disabled={!tooltipLabel}>
				<Group gap={6} wrap="nowrap">
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
