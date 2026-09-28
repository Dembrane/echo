import { Badge } from "@mantine/core";
import type { Icon } from "@tabler/icons-react";
import clsx from "clsx";

interface TipBannerProps {
	icon?: Icon;
	message?: string;
	tipLabel?: string;
	color?: "blue" | "green" | "yellow" | "red" | "gray";
}

export function TipBanner({
	icon: Icon,
	message,
	tipLabel,
	color = "blue",
}: TipBannerProps) {
	const colorClasses = {
		blue: {
			badgeBorder: "border-blue-300",
			badgeText: "text-blue-700",
			bg: "bg-blue-50",
			border: "border-blue-200",
			icon: "text-blue-600",
			text: "text-blue-800",
		},
		gray: {
			badgeBorder: "border-gray-300",
			badgeText: "text-gray-700",
			bg: "bg-gray-50",
			border: "border-gray-200",
			icon: "text-gray-600",
			text: "text-gray-800",
		},
		green: {
			badgeBorder: "border-green-300",
			badgeText: "text-green-700",
			bg: "bg-green-50",
			border: "border-green-200",
			icon: "text-green-600",
			text: "text-green-800",
		},
		red: {
			badgeBorder: "border-red-300",
			badgeText: "text-red-700",
			bg: "bg-red-50",
			border: "border-red-200",
			icon: "text-red-600",
			text: "text-red-800",
		},
		yellow: {
			badgeBorder: "border-yellow-300",
			badgeText: "text-yellow-700",
			bg: "bg-yellow-50",
			border: "border-yellow-200",
			icon: "text-yellow-600",
			text: "text-yellow-800",
		},
	}[color];

	return (
		<div
			className={clsx(
				"flex items-start gap-3 rounded-md border p-3",
				colorClasses.border,
				colorClasses.bg,
			)}
		>
			{Icon && (
				<Icon className={clsx("mt-0.5 h-4 w-4 shrink-0", colorClasses.icon)} />
			)}
			{message && (
				<span className={clsx("flex-1 text-sm", colorClasses.text)}>
					{message}
				</span>
			)}
			{tipLabel && (
				<Badge
					variant="outline"
					className={clsx(
						"ml-auto shrink-0",
						colorClasses.badgeBorder,
						colorClasses.badgeText,
					)}
				>
					{tipLabel}
				</Badge>
			)}
		</div>
	);
}
