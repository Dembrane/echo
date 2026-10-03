import { ArrowLeft } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { I18nLink } from "@/components/common/i18nLink";
import { cn } from "@/lib/utils";
import { RAIL_ITEM_CLASS, RailTip, useInRail } from "../shell/rail";

interface BackButtonProps {
	to: string;
	label: ReactNode;
	// Context header: sticks to the top of the sidebar section and carries the
	// current context's name (e.g. the org name), not the destination.
	center?: boolean;
}

export const BackButton = ({ to, label, center }: BackButtonProps) => {
	const inRail = useInRail();

	if (inRail) {
		return (
			<RailTip label={label}>
				<I18nLink
					to={to}
					className={cn(RAIL_ITEM_CLASS, "text-graphite hover:bg-[#e6e3df]")}
				>
					<ArrowLeft size={16} aria-hidden="true" />
					<span className="sr-only">{label}</span>
				</I18nLink>
			</RailTip>
		);
	}

	if (center) {
		return (
			<div className="sticky top-0 z-10 -mx-1.5 -mt-1.5 bg-parchment px-1.5 pt-1.5">
				<I18nLink
					to={to}
					className="group relative flex h-[30px] items-center gap-2 px-2 text-sm leading-tight text-graphite transition-colors hover:bg-[#e6e3df] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
				>
					<ArrowLeft
						size={16}
						className="shrink-0 transition-transform group-hover:-translate-x-0.5"
						aria-hidden="true"
					/>
					<span className="flex-1 truncate">{label}</span>
				</I18nLink>
			</div>
		);
	}

	return (
		<I18nLink
			to={to}
			className="group flex h-[30px] items-center gap-2 px-2 text-sm leading-tight text-graphite transition-colors hover:bg-[#e6e3df] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
		>
			<ArrowLeft
				size={16}
				className="shrink-0 transition-transform group-hover:-translate-x-0.5"
				aria-hidden="true"
			/>
			<span
				className="app-muted truncate"
				style={{ color: "var(--mantine-color-dimmed)" }}
			>
				{label}
			</span>
		</I18nLink>
	);
};
