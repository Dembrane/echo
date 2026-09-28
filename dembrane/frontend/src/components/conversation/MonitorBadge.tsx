import { Badge, type BadgeProps, type ElementProps } from "@mantine/core";

/** A monitor status tag. Label and any left icon render in graphite (app text)
 * rather than a saturated tint, so every informational tag on the monitor reads
 * the same: grey border, charcoal text.
 *
 * Mantine's Badge is polymorphic and forwards unknown props to its root, so the
 * wrapper takes the div element props too. */
export const MonitorBadge = ({
	styles,
	...props
}: BadgeProps & ElementProps<"div", "color">) => {
	const base = typeof styles === "object" && styles ? styles : {};
	const label =
		"label" in base ? (base as { label?: object }).label : undefined;
	const section =
		"section" in base ? (base as { section?: object }).section : undefined;
	return (
		<Badge
			{...props}
			styles={{
				...base,
				label: { color: "var(--app-text)", ...label },
				section: { color: "var(--app-text)", ...section },
			}}
		/>
	);
};
