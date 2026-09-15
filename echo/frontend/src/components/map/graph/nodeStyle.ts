import { baseColors } from "@/colors";
import {
	type AttributeInputs,
	attributeFor,
	attributeInputsOf,
	resolveAttribute,
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
		fill: value.color,
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

/** Radius multiplier of a node: its own scale, else its type's. */
export const nodeSizeScale = (node: Pick<MapGraphNode, "metadata">): number =>
	node.metadata.sizeScale > 0
		? node.metadata.sizeScale
		: sizeScaleFor(node.metadata.objectType);
