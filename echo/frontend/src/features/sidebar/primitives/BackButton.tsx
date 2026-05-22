import { ArrowLeft } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { I18nLink } from "@/components/common/i18nLink";

interface BackButtonProps {
	to: string;
	label: ReactNode;
}

export const BackButton = ({ to, label }: BackButtonProps) => {
	return (
		<I18nLink
			to={to}
			className="group flex h-[30px] items-center gap-1.5 rounded-md px-2 text-[13px] leading-tight transition-colors hover:bg-black/[0.04] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#4169e1]"
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
