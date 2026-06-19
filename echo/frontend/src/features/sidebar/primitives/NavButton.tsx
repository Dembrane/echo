import {
	ArrowUpRightIcon,
	CaretRightIcon,
	type Icon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
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
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className="group relative flex h-[30px] w-full items-center gap-2 rounded-md px-2 text-left text-sm leading-tight transition-colors hover:bg-black/[0.04] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#4169e1] disabled:cursor-not-allowed disabled:opacity-50"
			style={{ color: destructive ? "#c0392b" : "#2d2d2c" }}
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
					className="relative shrink-0 rounded px-1.5 py-0.5 text-xs leading-none"
					style={BADGE_TONES[badgeTone]}
				>
					{badge}
				</span>
			)}
			{external && (
				<ArrowUpRightIcon
					size={13}
					className="relative shrink-0 opacity-0 transition-opacity group-hover:opacity-55 group-focus-visible:opacity-55"
					aria-hidden="true"
				/>
			)}
			{pushes && (
				<CaretRightIcon
					size={13}
					className="relative shrink-0 opacity-45"
					aria-hidden="true"
				/>
			)}
		</button>
	);
};
