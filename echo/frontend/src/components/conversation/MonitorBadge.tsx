import { Badge, type BadgeProps } from "@mantine/core";

/** A monitor status tag: keeps its color as the background/dot but renders the
 * label in graphite (app text), on-brand instead of a saturated tint. */
export const MonitorBadge = ({ styles, ...props }: BadgeProps) => {
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
