/**
 * Relationship overlays, shared by both renderers: explicit relations drawn
 * as dashed lines in their own colour, visually apart from the grey tree
 * edges and the red neighbour links. Lines only; relations never reach the
 * forces, the tree, centrality or the walk.
 */
import { baseColors } from "@/colors";
import type { RelationLine } from "../layout/edgeBudget";
import type { BaseType, Selection } from "./d3";

/** Relationship stroke; follows --map-relation when the parent sets it. */
export const relationStroke = (darkMode: boolean) =>
	`var(--map-relation, ${darkMode ? baseColors.parchment : baseColors.graphite})`;

export const RELATION_DASH = "6,4";
const RELATION_OPACITY = 0.75;

/** Lines touching the selected node are drawn heavier. */
export const relationWidth = (line: RelationLine) =>
	line.incident ? 2.5 : 1.5;

export type RelationLineSelection = Selection<
	SVGLineElement,
	RelationLine,
	BaseType,
	unknown
>;

/** Joins the relationship lines into their group, one element per node pair. */
export function joinRelationLines(
	group: Selection<SVGGElement, unknown, null, undefined>,
	lines: RelationLine[],
	darkMode: boolean,
): RelationLineSelection {
	return group
		.selectAll<SVGLineElement, RelationLine>("line.relation")
		.data(lines, (d) => d.key)
		.join(
			(enter) =>
				enter
					.append("line")
					.attr("class", "relation")
					.attr("stroke-dasharray", RELATION_DASH)
					.attr("stroke-linecap", "round")
					.attr("pointer-events", "none"),
			(update) => update,
			(exit) => exit.remove(),
		)
		.attr("stroke", relationStroke(darkMode))
		.attr("stroke-opacity", RELATION_OPACITY)
		.attr("stroke-width", relationWidth)
		.attr("data-relation-types", (d) => d.types.join(" "));
}

/** Moves relationship lines to their nodes' current positions. */
export function drawRelationPositions(
	lines: RelationLineSelection | null,
	nodeById: ReadonlyMap<string, { x?: number; y?: number }>,
) {
	lines
		?.attr("x1", (d) => nodeById.get(d.source)?.x ?? null)
		.attr("y1", (d) => nodeById.get(d.source)?.y ?? null)
		.attr("x2", (d) => nodeById.get(d.target)?.x ?? null)
		.attr("y2", (d) => nodeById.get(d.target)?.y ?? null);
}
