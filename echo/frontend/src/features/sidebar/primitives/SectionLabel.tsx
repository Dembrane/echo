import type { ReactNode } from "react";

interface SectionLabelProps {
	children: ReactNode;
}

export const SectionLabel = ({ children }: SectionLabelProps) => {
	return (
		<div
			className="px-2 pb-1 pt-2 text-xs uppercase"
			style={{ color: "rgba(45, 45, 44, 0.5)" }}
		>
			{children}
		</div>
	);
};
