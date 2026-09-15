import { baseColors } from "@/colors";
import type {
	ColorBy,
	FactCheckState,
	MapGraphNode,
	MapKind,
	MapValence,
} from "../types";

// Data-visualisation palette. These greys and the neighbour-link red have no
// named brand colour; every other map colour comes from @/colors.
export const MAP_NEUTRAL_GREY = "#9CA3AF";
export const MAP_EDGE_GREY = "#D1D5DB";
export const MAP_NEIGHBOUR_LINK_RED = "#FF0000";

/** Hover outline, cursor ring and timer arc. */
export const MAP_HIGHLIGHT = baseColors.institutionBlue;

export type DisplayVerdict =
	| "true"
	| "false"
	| "contested"
	| "unknown"
	| "processing";

export interface NodeStyle {
	fill: string;
	stroke: string;
	strokeWidth: number;
	// SVG filter string applied via the `filter` attribute. Lifts coloured
	// fills off the parchment background in light mode; 'none' in dark mode.
	filter: string;
	pulse: boolean;
}

export interface NodeStyleOptions {
	colorBy: ColorBy;
	darkMode?: boolean;
}

/** Metadata a renderer needs to style a node. */
export interface NodeStyleInputs {
	kind?: MapKind;
	valence?: MapValence;
	factCheck?: FactCheckState;
}

// Valence fills, used when colorBy === "valence".
const VALENCE_FILL: Record<MapValence, string> = {
	negative: baseColors.salmon,
	neutral: MAP_NEUTRAL_GREY,
	positive: baseColors.springGreen,
};

// Fact-check fills, used when colorBy === "factCheck". Arguments render grey
// ("fact-check not applicable") so they stay distinct from the spring-green
// "likely true" against parchment.
const FACT_CHECK_FILL = {
	argument: MAP_NEUTRAL_GREY,
	contested: baseColors.limeYellow,
	false: baseColors.salmon,
	processing: baseColors.institutionBlue,
	true: baseColors.springGreen,
	unknown: baseColors.graphite,
} as const;

const NEUTRAL_FILL = MAP_NEUTRAL_GREY;

export const deriveDisplayVerdict = (
	factCheck: FactCheckState | undefined,
): DisplayVerdict => {
	if (!factCheck) return "unknown";
	switch (factCheck.status) {
		case "done":
			return factCheck.verdict;
		case "processing":
			return "processing";
		default:
			return "unknown";
	}
};

// Graphite drop-shadow applied to coloured nodes in light mode so fills pop
// against parchment. Omitted in dark mode where the shapes already contrast.
const LIGHT_SHADOW = "drop-shadow(0 1px 2px rgba(45, 45, 44, 0.35))";

const pickFill = (
	inputs: NodeStyleInputs,
	colorBy: ColorBy,
): { fill: string; pulse: boolean } => {
	const kind = inputs.kind ?? "argument";
	if (colorBy === "none") {
		return { fill: NEUTRAL_FILL, pulse: false };
	}
	if (colorBy === "valence") {
		const valence = inputs.valence ?? "neutral";
		return { fill: VALENCE_FILL[valence], pulse: false };
	}
	// colorBy === "factCheck"
	if (kind === "argument") {
		return { fill: FACT_CHECK_FILL.argument, pulse: false };
	}
	const verdict = deriveDisplayVerdict(inputs.factCheck);
	return { fill: FACT_CHECK_FILL[verdict], pulse: verdict === "processing" };
};

export const getNodeStyleFromInputs = (
	inputs: NodeStyleInputs,
	options: NodeStyleOptions,
): NodeStyle => {
	const { colorBy, darkMode = false } = options;
	const filter = darkMode ? "none" : LIGHT_SHADOW;
	const { fill, pulse } = pickFill(inputs, colorBy);
	return {
		fill,
		filter,
		pulse,
		stroke: "transparent",
		strokeWidth: 0,
	};
};

export const getNodeStyle = (
	node: Pick<MapGraphNode, "metadata">,
	options: NodeStyleOptions,
): NodeStyle =>
	getNodeStyleFromInputs(
		{
			factCheck: node.metadata.factCheck,
			kind: node.metadata.kind,
			valence: node.metadata.valence,
		},
		options,
	);
