import type { ReactNode } from "react";
import { useInRail } from "../shell/rail";

interface SectionLabelProps {
	children: ReactNode;
}

export const SectionLabel = ({ children }: SectionLabelProps) => {
	if (useInRail()) return null;
	return (
		<div
			className="px-2 pb-1 pt-2 text-xs uppercase"
			style={{ color: "rgba(45, 45, 44, 0.5)" }}
		>
			{children}
		</div>
	);
};
