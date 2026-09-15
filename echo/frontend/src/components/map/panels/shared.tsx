import { t } from "@lingui/core/macro";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { DisplayVerdict } from "../graph/nodeStyle";
import type { MapValence } from "../types";

// Panel colours follow the map-scoped variables MapPage sets for light and
// dark, so the map's dark mode never touches the rest of the app.
export const mapVars = {
	accentBorder: "var(--map-accent-border)",
	accentSurface: "var(--map-accent-surface)",
	accentText: "var(--map-accent-text)",
	border: "var(--map-border)",
	card: "var(--map-card)",
	muted: "var(--map-muted)",
	raised: "var(--map-surface-raised)",
	surface: "var(--map-surface)",
	text: "var(--map-text)",
} as const;

export const valenceLabel = (valence: MapValence): string => {
	switch (valence) {
		case "positive":
			return t`Positive`;
		case "negative":
			return t`Negative`;
		default:
			return t`Neutral`;
	}
};

export const VALENCE_CHIP_CLASS: Record<MapValence, string> = {
	negative: "bg-salmon text-graphite",
	neutral: "bg-gray-300 text-graphite",
	positive: "bg-springGreen text-graphite",
};

export const valenceBlurb = (valence: MapValence): string => {
	switch (valence) {
		case "positive":
			return t`This argument expresses support, agreement, or a positive stance toward its subject.`;
		case "negative":
			return t`This argument expresses opposition, disagreement, or concern.`;
		default:
			return t`This argument is observational or balanced, neither for nor against.`;
	}
};

export const verdictLabel = (verdict: DisplayVerdict): string => {
	switch (verdict) {
		case "true":
			return t`Likely true`;
		case "false":
			return t`Likely false`;
		case "contested":
			return t`Contested`;
		case "processing":
			return t`Checking…`;
		default:
			return t`Unverified`;
	}
};

export const VERDICT_CHIP_CLASS: Record<DisplayVerdict, string> = {
	contested: "bg-limeYellow text-graphite",
	false: "bg-salmon text-graphite",
	processing: "bg-primary text-white",
	true: "bg-springGreen text-graphite",
	unknown: "bg-graphite text-parchment",
};

export const OPINION_CHIP_CLASS = "bg-gray-400 text-graphite";

export const CHIP_CLASS =
	"inline-block rounded-none px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wider";

/** DDW's "Aug 5, 1:33 PM", in the page's locale. Empty when unreadable. */
export const formatTimestamp = (
	value: string | number | null | undefined,
	locale?: string,
): string => {
	if (value === null || value === undefined || value === "") return "";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "";
	try {
		return new Intl.DateTimeFormat(locale || "en-US", {
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
			month: "short",
		}).format(date);
	} catch {
		return new Intl.DateTimeFormat("en-US", {
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
			month: "short",
		}).format(date);
	}
};

/** Panel header: uppercase title and the panel's colour dot. */
export const PanelHeader = ({
	title,
	dotClassName,
}: {
	title: ReactNode;
	dotClassName: string;
}) => (
	<header
		className="mb-3 flex items-center justify-between border-b pb-1"
		style={{ borderColor: mapVars.border }}
	>
		<h2 className="text-xs font-light uppercase tracking-wider">{title}</h2>
		<span
			aria-hidden="true"
			className={cn("inline-flex h-3 w-3 rounded-full", dotClassName)}
		/>
	</header>
);

export const MutedText = ({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) => (
	<p className={cn("text-xs", className)} style={{ color: mapVars.muted }}>
		{children}
	</p>
);
