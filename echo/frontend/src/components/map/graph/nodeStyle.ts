import { baseColors } from "@/colors";
import {
	type AttributeInputs,
	attributeFor,
	attributeInputsOf,
	resolveAttribute,
	resolveMapColor,
	sizeScaleFor,
} from "../attributes";
import type { ColorBy, MapGraphNode } from "../types";

export {
	type DisplayVerdict,
	deriveDisplayVerdict,
	MAP_NEUTRAL_GREY,
} from "../attributes";

// Data-visualisation palette. These greys and the neighbour-link red have no
// named brand colour; node fills come from the attribute definitions.
export const MAP_EDGE_GREY = "#D1D5DB";
export const MAP_NEIGHBOUR_LINK_RED = "#FF0000";

/** Hover outline, cursor ring and timer arc. */
export const MAP_HIGHLIGHT = baseColors.institutionBlue;

/**
 * The same highlight for the dark room screen. Institution blue reads well on
 * parchment but sinks into a near-black background, so dark mode borrows the
 * audience shell's lifted blue, the one it already uses for thin lines.
 */
export const MAP_HIGHLIGHT_DARK = "#7C9BFF";

/** Hover outline, cursor ring and timer arc as the current theme draws them. */
export const mapHighlight = (darkMode: boolean): string =>
	darkMode ? MAP_HIGHLIGHT_DARK : MAP_HIGHLIGHT;

export interface NodeStyle {
	fill: string;
	stroke: string;
	strokeWidth: number;
	// SVG filter string applied via the `filter` attribute. Lifts coloured
	// fills off the parchment background in light mode; 'none' in dark mode.
	filter: string;
	pulse: boolean;
	/** The state the fill stands for, such as "Not assessed". */
	label: string;
}

export interface NodeStyleOptions {
	colorBy: ColorBy;
	darkMode?: boolean;
}

/** Metadata a renderer needs to style a node. */
export type NodeStyleInputs = AttributeInputs;

// Graphite drop-shadow applied to coloured nodes in light mode so fills pop
// against parchment. Omitted in dark mode where the shapes already contrast.
const LIGHT_SHADOW = "drop-shadow(0 1px 2px rgba(45, 45, 44, 0.35))";

/** The one style resolver both renderers and the legend use. */
export const getNodeStyleFromInputs = (
	inputs: NodeStyleInputs,
	options: NodeStyleOptions,
): NodeStyle => {
	const { colorBy, darkMode = false } = options;
	const value = resolveAttribute(attributeFor(colorBy), inputs);
	return {
		fill: resolveMapColor(value.color, darkMode),
		filter: darkMode ? "none" : LIGHT_SHADOW,
		label: value.label,
		pulse: value.pulse,
		stroke: "transparent",
		strokeWidth: 0,
	};
};

export const getNodeStyle = (
	node: Pick<MapGraphNode, "metadata">,
	options: NodeStyleOptions,
): NodeStyle =>
	getNodeStyleFromInputs(attributeInputsOf(node.metadata), options);

/** Bounded radius multiplier for a verified merge. */
export const consolidationSizeScale = (memberCount: number): number =>
	memberCount > 1 ? Math.min(1.8, 1 + 0.2 * Math.log2(memberCount)) : 1;

/** Radius multiplier from type and, when present, verified merge lineage. */
export const nodeSizeScale = (node: Pick<MapGraphNode, "metadata">): number => {
	const typeScale =
		node.metadata.sizeScale > 0
			? node.metadata.sizeScale
			: sizeScaleFor(node.metadata.objectType);
	const memberCount = node.metadata.consolidation?.memberCount ?? 1;
	return Math.max(typeScale, consolidationSizeScale(memberCount));
};
