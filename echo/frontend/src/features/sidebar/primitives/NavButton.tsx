import { ArrowUpRight, CaretRight, type Icon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

interface NavButtonProps {
	label: ReactNode;
	icon?: Icon;
	onClick: () => void;
	pushes?: boolean;
	badge?: ReactNode;
	destructive?: boolean;
	disabled?: boolean;
	external?: boolean;
}

export const NavButton = ({
	label,
	icon: Icon,
	onClick,
	pushes,
	badge,
	destructive,
	disabled,
	external,
}: NavButtonProps) => {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className="group relative flex h-[30px] w-full items-center gap-2 rounded-md px-2 text-left text-[13px] leading-tight transition-colors hover:bg-black/[0.04] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#4169e1] disabled:cursor-not-allowed disabled:opacity-50"
			style={{ color: destructive ? "#c0392b" : "#2d2d2c" }}
		>
			<span className="relative flex flex-1 items-center gap-2 truncate">
				{Icon ? <Icon size={16} /> : null}
				<span className="truncate">{label}</span>
			</span>
			{badge && (
				<span
					className="relative shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-none"
					style={{
						backgroundColor: "rgba(45, 45, 44, 0.06)",
						color: "rgba(45, 45, 44, 0.55)",
					}}
				>
					{badge}
				</span>
			)}
			{external && (
				<ArrowUpRight
					size={13}
					className="relative shrink-0 opacity-0 transition-opacity group-hover:opacity-55 group-focus-visible:opacity-55"
					aria-hidden="true"
				/>
			)}
			{pushes && (
				<CaretRight
					size={13}
					className="relative shrink-0 opacity-45"
					aria-hidden="true"
				/>
			)}
		</button>
	);
};
