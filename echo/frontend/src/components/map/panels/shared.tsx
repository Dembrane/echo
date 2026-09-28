import { t } from "@lingui/core/macro";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { OBJECT_TYPE_STYLES } from "../attributes";
import type { MapProvenanceInfo, StakeholderRung } from "../data/adapter";
import type { DisplayVerdict } from "../graph/nodeStyle";
import type { MapValence, ObjectType } from "../types";

// Panel colours follow the map-scoped variables MapPage sets for light and
// dark, so the map's dark mode never touches the rest of the app.
export const mapVars = {
	accentBorder: "var(--map-accent-border)",
	accentSurface: "var(--map-accent-surface)",
	accentText: "var(--map-accent-text)",
	border: "var(--map-border)",
	card: "var(--map-card)",
	raised: "var(--map-surface-raised)",
	surface: "var(--map-surface)",
	text: "var(--map-text)",
} as const;

/** A missing valence is "Not assessed", never neutral. */
export const valenceLabel = (valence: MapValence | undefined): string => {
	switch (valence) {
		case "positive":
			return t`Positive`;
		case "negative":
			return t`Negative`;
		case "neutral":
			return t`Neutral`;
		default:
			return t`Not assessed`;
	}
};

export const VALENCE_CHIP_CLASS: Record<MapValence, string> = {
	negative: "bg-salmon text-graphite",
	neutral: "bg-gray-300 text-graphite",
	positive: "bg-springGreen text-graphite",
};

export const NOT_ASSESSED_CHIP_CLASS =
	"border border-gray-300 bg-transparent text-current";

export const valenceChipClass = (valence: MapValence | undefined): string =>
	valence ? VALENCE_CHIP_CLASS[valence] : NOT_ASSESSED_CHIP_CLASS;

export const valenceBlurb = (valence: MapValence | undefined): string => {
	switch (valence) {
		case "positive":
			return t`This argument expresses support, agreement, or a positive stance toward its subject.`;
		case "negative":
			return t`This argument expresses opposition, disagreement, or concern.`;
		case "neutral":
			return t`This argument is observational or balanced, neither for nor against.`;
		default:
			return t`The valence of this object has not been assessed.`;
	}
};

export const relationLabel = (type: string): string => {
	switch (type) {
		case "supports_pole_a":
			return t`Supports pole A`;
		case "supports_pole_b":
			return t`Supports pole B`;
		case "derived_from":
			return t`Combined from`;
		case "holds_position":
			return t`Holds position`;
		case "affected_by":
			return t`Affected by`;
		default:
			return type.split("_").join(" ");
	}
};

export const basisLabel = (basis: "extracted" | "inferred" | "authored") => {
	switch (basis) {
		case "extracted":
			return t`From the transcript`;
		case "authored":
			return t`Added by a host`;
		default:
			return t`Inferred`;
	}
};

export const rungLabel = (rung: StakeholderRung | null): string => {
	switch (rung) {
		case "voiced":
			return t`Voiced in a conversation`;
		case "named":
			return t`Named by participants`;
		case "inferred":
			return t`Inferred`;
		default:
			return t`Not recorded`;
	}
};

export const originLabel = (provenance: MapProvenanceInfo): string => {
	if (provenance.legacy) return t`Earlier map result`;
	switch (provenance.origin) {
		case "generated":
			return t`Generated`;
		case "authored":
			return t`Added by a host`;
		default:
			return t`Imported`;
	}
};

/** The type's colour dot, as nodes show it under Type colouring. */
export const TypeDot = ({ type }: { type: ObjectType }) => (
	<span
		aria-hidden="true"
		className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
		style={{ backgroundColor: OBJECT_TYPE_STYLES[type].color }}
	/>
);

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

/** Hints, empty states and labels: set apart by size, in the text colour. */
export const CaptionText = ({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) => <p className={cn("text-xs", className)}>{children}</p>;
