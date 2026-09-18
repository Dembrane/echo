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
	const style = {
		background: selected
			? "var(--mantine-color-primary-0)"
			: "var(--app-background)",
		borderColor:
			active || selected ? "var(--mantine-color-primary-6)" : undefined,
	} as const;
	const testProps = testId ? testIdAttribute(testId) : {};

	if (href) {
		return (
			<I18nLink
				to={href}
				className="no-underline block"
				style={{ color: "inherit" }}
			>
				<Paper
					withBorder
					radius="sm"
					p="md"
					className="cursor-pointer transition-colors hover:!border-primary-400"
					style={style}
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
				withBorder
				radius="sm"
				p="md"
				className="cursor-pointer transition-colors hover:!border-primary-400"
				style={style}
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
		<Paper withBorder radius="sm" p="md" style={style} {...testProps}>
			{children}
		</Paper>
	);
}
