/**
 * Nodes drawn from more than one colour. A merged argument belongs to every
 * conversation it was combined from, so the renderers paint it as a gradient
 * of its members' colours rather than picking a winner. One `<linearGradient>`
 * per such node, in the svg's own defs, rebuilt whenever the colours change.
 */
import type { NodeStyle } from "../graph/nodeStyle";
import { d3 } from "./d3";

export type GradientStop = { offset: number; color: string };

/**
 * The stops of one blend: each colour holds a band as wide as the share of
 * members that gave it, and the colour sits in the middle of its band, so the
 * bands read as one blend rather than as slices. Deterministic: the colours
 * arrive in slot order and equal colours are counted together.
 */
export function blendStops(colors: ReadonlyArray<string>): GradientStop[] {
	if (colors.length === 0) return [];
	const weights: Array<{ color: string; weight: number }> = [];
	for (const color of colors) {
		const last = weights[weights.length - 1];
		if (last && last.color === color) last.weight += 1;
		else weights.push({ color, weight: 1 });
	}
	if (weights.length === 1) {
		return [
			{ color: weights[0].color, offset: 0 },
			{ color: weights[0].color, offset: 1 },
		];
	}
	const total = weights.reduce((sum, band) => sum + band.weight, 0);
	const stops: GradientStop[] = [{ color: weights[0].color, offset: 0 }];
	let seen = 0;
	for (const band of weights) {
		stops.push({
			color: band.color,
			offset: (seen + band.weight / 2) / total,
		});
		seen += band.weight;
	}
	stops.push({ color: weights[weights.length - 1].color, offset: 1 });
	return stops;
}

/**
 * The same blend as a CSS background, for the panels: a chit that stands for
 * several conversations is filled the way their node is drawn, corner to
 * corner and weighted the same. Empty where there is nothing to blend.
 */
export function blendBackground(colors: ReadonlyArray<string>): string {
	const stops = blendStops(colors);
	if (stops.length === 0) return "";
	const bands = stops
		.map((stop) => `${stop.color} ${Math.round(stop.offset * 1000) / 10}%`)
		.join(", ");
	return `linear-gradient(135deg, ${bands})`;
}

/** An id for one node's gradient that is safe in a `url(#…)` reference. */
export const gradientId = (prefix: string, nodeId: string): string =>
	`${prefix}-${nodeId}`.replace(/[^A-Za-z0-9_-]/g, "_");

/**
 * Puts a gradient in the svg's defs for every node whose style blends, and
 * answers with the fill each node is drawn with: a `url(#…)` for a blended
 * node, its flat colour for every other. Nodes that stopped blending lose
 * their gradient.
 */
export function resolveNodeFills<T extends { id: string }>(
	svgElement: SVGSVGElement,
	prefix: string,
	nodes: ReadonlyArray<T>,
	styleOf: (id: string) => NodeStyle,
): (id: string) => string {
	const svg = d3.select(svgElement);
	let defs = svg.select<SVGDefsElement>("defs.node-blends");
	if (defs.empty()) {
		defs = svg.append("defs").attr("class", "node-blends");
	}
	const blended = nodes.filter((node) => styleOf(node.id).blend.length > 1);
	defs
		.selectAll<SVGLinearGradientElement, T>("linearGradient")
		.data(blended, (node) => node.id)
		.join("linearGradient")
		.attr("id", (node) => gradientId(prefix, node.id))
		// Across the node, corner to corner, so a blend reads at node size.
		.attr("x1", "0%")
		.attr("y1", "0%")
		.attr("x2", "100%")
		.attr("y2", "100%")
		.each(function eachGradient(node) {
			d3.select(this)
				.selectAll<SVGStopElement, GradientStop>("stop")
				.data(blendStops(styleOf(node.id).blend))
				.join("stop")
				.attr("offset", (stop) => `${Math.round(stop.offset * 1000) / 10}%`)
				.attr("stop-color", (stop) => stop.color);
		});

	const ids = new Set(blended.map((node) => node.id));
	return (id: string) =>
		ids.has(id) ? `url(#${gradientId(prefix, id)})` : styleOf(id).fill;
}
