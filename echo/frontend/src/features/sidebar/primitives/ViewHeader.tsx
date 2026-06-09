import { ArrowLeft } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { I18nLink } from "@/components/common/i18nLink";

interface ViewHeaderProps {
	to: string;
	title: ReactNode;
}

export const ViewHeader = ({ to, title }: ViewHeaderProps) => {
	return (
		<I18nLink
			to={to}
			className="group grid h-[36px] grid-cols-[22px_1fr_22px] items-center rounded-md px-2 text-[14px] leading-tight transition-colors hover:bg-black/[0.04] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#4169e1]"
			style={{ color: "#2d2d2c" }}
		>
			<ArrowLeft
				size={14}
				className="transition-transform group-hover:-translate-x-0.5"
				aria-hidden="true"
			/>
			<span className="truncate text-center uppercase">{title}</span>
			<span aria-hidden="true" />
		</I18nLink>
	);
};
