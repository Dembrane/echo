import { Badge, Group, Text, Tooltip } from "@mantine/core";
import type { MantineSize } from "@mantine/core";
import { taglineFor } from "@/lib/tiers";

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

	if (showTagline && tagline) {
		return (
			<Group gap={6} wrap="nowrap">
				{badge}
				<Text size="xs" c="dimmed">
					— {tagline}
				</Text>
			</Group>
		);
	}

	if (tagline) {
		return <Tooltip label={tagline}>{badge}</Tooltip>;
	}

	return badge;
};
