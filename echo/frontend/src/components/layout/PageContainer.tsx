import type { CSSProperties, PropsWithChildren } from "react";

interface PageContainerProps {
	/** Page width preset. `lg` = 1024px content, `xl` = 1280px, `full` = 100%. Default `lg`. */
	width?: "sm" | "md" | "lg" | "xl" | "full";
	/** Reduce vertical padding for dense pages. Default `relaxed`. */
	density?: "tight" | "relaxed";
	className?: string;
	style?: CSSProperties;
}

const WIDTHS = {
	sm: 640,
	md: 768,
	lg: 1024,
	xl: 1280,
	full: undefined,
} as const;

// Single source of truth for main-content page max-width + horizontal
// padding. Every full-page route should wrap its content in this so the
// app feels coherent across scopes.
export const PageContainer = ({
	width = "lg",
	density = "relaxed",
	className,
	style,
	children,
}: PropsWithChildren<PageContainerProps>) => {
	const maxWidth = WIDTHS[width];
	const pyClass = density === "tight" ? "py-6" : "py-10";
	return (
		<div
			className={`mx-auto w-full px-6 md:px-10 ${pyClass} ${className ?? ""}`}
			style={{ maxWidth, ...style }}
		>
			{children}
		</div>
	);
};
