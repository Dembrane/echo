import { Alert, Badge, Group, Text } from "@mantine/core";
import type { Icon } from "@phosphor-icons/react";

interface TipBannerProps {
	icon?: Icon;
	message?: string;
	tipLabel?: string;
	color?: "blue" | "green" | "yellow" | "red" | "gray";
}

// An inline notice: the Alert's two rules, the status colour on the icon.
export function TipBanner({
	icon: Icon,
	message,
	tipLabel,
	color = "blue",
}: TipBannerProps) {
	return (
		<Alert
			color={color === "blue" ? "primary" : color}
			icon={Icon ? <Icon size={20} /> : undefined}
		>
			<Group gap="sm" align="flex-start" wrap="nowrap">
				{message && (
					<Text size="sm" className="flex-1">
						{message}
					</Text>
				)}
				{tipLabel && (
					<Badge
						color={color === "blue" ? "primary" : color}
						className="shrink-0"
					>
						{tipLabel}
					</Badge>
				)}
			</Group>
		</Alert>
	);
}
