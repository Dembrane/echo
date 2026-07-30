import { Badge, type BadgeProps, type ElementProps } from "@mantine/core";

/** A monitor status tag: keeps its color as the background/dot but renders the
 * label in graphite (app text), on-brand instead of a saturated tint.
 *
 * Mantine's Badge is polymorphic and forwards unknown props to its root, so the
 * wrapper takes the div element props too. Without them a caller can't attach
 * onClick / keyboard handlers, which is what the filterable badges need. */
export const MonitorBadge = ({
	styles,
	...props
}: BadgeProps & ElementProps<"div", "color">) => {
	const base = typeof styles === "object" && styles ? styles : {};
	const label =
		"label" in base ? (base as { label?: object }).label : undefined;
	return (
		<Badge
			{...props}
			styles={{ ...base, label: { color: "var(--app-text)", ...label } }}
		/>
	);
};
