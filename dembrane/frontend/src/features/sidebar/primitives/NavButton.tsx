import {
	ArrowUpRightIcon,
	CaretRightIcon,
	type Icon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { roles } from "@/colors";
import { cn } from "@/lib/utils";
import { RAIL_ITEM_CLASS, RailTip, useInRail } from "../shell/rail";
import { BADGE_TONES } from "./NavItem";

interface NavButtonProps {
	label: ReactNode;
	icon?: Icon;
	/** Override the icon color (e.g. a brand accent). Defaults to the text color. */
	iconColor?: string;
	/** Override the label color (e.g. a brand accent). Defaults to the text color. */
	labelColor?: string;
	onClick: () => void;
	pushes?: boolean;
	badge?: ReactNode;
	badgeTone?: "muted" | "notification";
	destructive?: boolean;
	disabled?: boolean;
	external?: boolean;
}

export const NavButton = ({
	label,
	icon: Icon,
	iconColor,
	labelColor,
	onClick,
	pushes,
	badge,
	badgeTone = "muted",
	destructive,
	disabled,
	external,
}: NavButtonProps) => {
	const inRail = useInRail();

	if (inRail) {
		if (!Icon) return null;
		const name = (
			<>
				{label}
				{badge != null ? <> {badge}</> : null}
			</>
		);
		return (
			<RailTip label={name}>
				<button
					type="button"
					onClick={onClick}
					disabled={disabled}
					className={cn(
						RAIL_ITEM_CLASS,
						"hover:bg-[#e6e3df] disabled:cursor-not-allowed disabled:opacity-50",
					)}
					style={{ color: destructive ? roles.danger : roles.text }}
				>
					<Icon size={20} color={iconColor} aria-hidden="true" />
					<span className="sr-only">{name}</span>
				</button>
			</RailTip>
		);
	}

	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className="group relative flex h-[30px] w-full items-center gap-2 px-2 text-left text-sm leading-tight transition-colors hover:bg-[#e6e3df] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#2957df] disabled:cursor-not-allowed disabled:opacity-50"
			style={{ color: destructive ? roles.danger : roles.text }}
		>
			<span className="relative flex flex-1 items-center gap-2 truncate">
				{Icon ? <Icon size={16} color={iconColor} /> : null}
				<span
					className="truncate"
					style={labelColor ? { color: labelColor } : undefined}
				>
					{label}
				</span>
			</span>
			{/* != null, not truthiness: badge={0} would render a bare "0" */}
			{badge != null && (
				<span
					className="relative shrink-0 px-1 py-0.5 text-xs leading-none"
					style={BADGE_TONES[badgeTone]}
				>
					{badge}
				</span>
			)}
			{external && (
				<ArrowUpRightIcon
					size={16}
					className="relative shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
					style={{ color: "var(--mantine-color-dimmed)" }}
					aria-hidden="true"
				/>
			)}
			{pushes && (
				<CaretRightIcon
					size={16}
					className="relative shrink-0"
					style={{ color: "var(--mantine-color-dimmed)" }}
					aria-hidden="true"
				/>
			)}
		</button>
	);
};
