import { ArrowLeft } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { I18nLink } from "@/components/common/i18nLink";

interface BackButtonProps {
	to: string;
	label: ReactNode;
	// Vercel-style context header: the back chevron sits at the left while the
	// label reads as the centered title of the whole sidebar section. The label
	// is the current context's name (e.g. the org name), not the destination.
	center?: boolean;
}

export const BackButton = ({ to, label, center }: BackButtonProps) => {
	if (center) {
		return (
			<I18nLink
				to={to}
				className="group relative flex h-[30px] items-center rounded-md px-2 text-sm leading-tight transition-colors hover:bg-black/[0.04] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#4169e1]"
				style={{ color: "#2d2d2c" }}
			>
				<ArrowLeft
					size={14}
					className="absolute left-2 shrink-0 transition-transform group-hover:-translate-x-0.5"
					aria-hidden="true"
				/>
				<span className="flex-1 truncate px-5 text-center font-medium">
					{label}
				</span>
			</I18nLink>
		);
	}

	return (
		<I18nLink
			to={to}
			className="group flex h-[30px] items-center gap-1.5 rounded-md px-2 text-sm leading-tight transition-colors hover:bg-black/[0.04] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#4169e1]"
			style={{ color: "#2d2d2c" }}
		>
			<ArrowLeft
				size={14}
				className="shrink-0 transition-transform group-hover:-translate-x-0.5"
				aria-hidden="true"
			/>
			<span className="truncate opacity-70">{label}</span>
		</I18nLink>
	);
};
