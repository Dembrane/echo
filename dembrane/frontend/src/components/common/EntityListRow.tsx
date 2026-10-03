import { Paper } from "@mantine/core";
import type { ReactNode } from "react";
import { I18nLink } from "@/components/common/i18nLink";
import { testId as testIdAttribute } from "@/lib/testUtils";

export type EntityListRowProps = {
	active?: boolean;
	ariaLabel?: string;
	children: ReactNode;
	href?: string;
	onActivate?: () => void;
	selected?: boolean;
	testId?: string;
};

export function EntityListRow({
	active = false,
	ariaLabel,
	children,
	href,
	onActivate,
	selected = false,
	testId,
}: EntityListRowProps) {
	// A row you press: the full box (rules.css .app-do); active or selected
	// is the blue box on the action tint.
	const isSelected = active || selected || undefined;
	const testProps = testId ? testIdAttribute(testId) : {};

	if (href) {
		return (
			<I18nLink
				to={href}
				className="no-underline block"
				style={{ color: "inherit" }}
			>
				<Paper
					p="md"
					className="app-do"
					data-selected={isSelected}
					{...testProps}
				>
					{children}
				</Paper>
			</I18nLink>
		);
	}

	if (onActivate) {
		return (
			<Paper
				p="md"
				className="app-do"
				data-selected={isSelected}
				role="button"
				tabIndex={0}
				aria-label={ariaLabel}
				onClick={onActivate}
				onKeyDown={(event) => {
					if (event.target !== event.currentTarget) return;
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						onActivate();
					}
				}}
				{...testProps}
			>
				{children}
			</Paper>
		);
	}

	return (
		<Paper withBorder p="md" {...testProps}>
			{children}
		</Paper>
	);
}
