import type { ReactNode } from "react";
import { useInRail } from "../shell/rail";

interface SectionLabelProps {
	children: ReactNode;
}

export const SectionLabel = ({ children }: SectionLabelProps) => {
	if (useInRail()) return null;
	return (
		<div
			className="app-muted px-2 pb-1 pt-2 text-xs"
			style={{ color: "var(--mantine-color-dimmed)" }}
		>
			{children}
		</div>
	);
};
