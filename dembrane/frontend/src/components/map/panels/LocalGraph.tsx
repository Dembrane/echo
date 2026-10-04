import { t } from "@lingui/core/macro";
import { useMemo } from "react";
import { getNodeStyle } from "../graph/nodeStyle";
import { d3, type SimulationNodeDatum } from "../renderers/d3";
import type { ColorBy, Edge, MapGraphNode, MapRelation } from "../types";
import { mapVars } from "./shared";

const WIDTH = 360;
const HEIGHT = 300;
const RADIUS = 7;

type GraphNode = SimulationNodeDatum & { id: string; focus: boolean };
type GraphLink = { source: string; target: string; relation: boolean };

/**
 * What an item connects to. For an argument: its neighbours in the tree and
 * its explicit relationships. For a cluster: its own arguments and the tree
 * edges between them.
 */
export const neighbourhood = (
	focusIds: ReadonlyArray<string>,
	edges: ReadonlyArray<Edge>,
	relations: ReadonlyArray<MapRelation>,
	expand: boolean,
): { ids: string[]; links: GraphLink[] } => {
	const focus = new Set(focusIds);
	const ids = new Set(focusIds);
	if (expand) {
		// Direct neighbours of the focus only, whatever order the edges come in.
		for (const edge of edges) {
			if (focus.has(edge.source) || focus.has(edge.target)) {
				ids.add(edge.source);
				ids.add(edge.target);
			}
		}
		for (const relation of relations) {
			if (focus.has(relation.source)) ids.add(relation.target);
			if (focus.has(relation.target)) ids.add(relation.source);
		}
	}
	const links: GraphLink[] = [
		...edges
			.filter((edge) => ids.has(edge.source) && ids.has(edge.target))
			.map((edge) => ({
				relation: false,
				source: edge.source,
				target: edge.target,
			})),
		...relations
			.filter(
				(relation) => ids.has(relation.source) && ids.has(relation.target),
			)
			.map((relation) => ({
				relation: true,
				source: relation.source,
				target: relation.target,
			})),
	];
	return { ids: [...ids], links };
};

/**
 * A small, still drawing of an item and what it connects to, in the map's
 * own colours. Laid out once (a few dozen nodes at most); a node pressed
 * here becomes the spotlight.
 */
export const LocalGraph = ({
	focusIds,
	expand,
	nodesById,
	edges,
	relations,
	colorBy,
	darkMode,
	onSelect,
}: {
	focusIds: ReadonlyArray<string>;
	/** True to draw the neighbours of the focus too (an argument). */
	expand: boolean;
	nodesById: ReadonlyMap<string, MapGraphNode>;
	edges: ReadonlyArray<Edge>;
	relations: ReadonlyArray<MapRelation>;
	colorBy: ColorBy;
	darkMode: boolean;
	onSelect: (nodeId: string) => void;
}) => {
	const layout = useMemo(() => {
		const { ids, links } = neighbourhood(focusIds, edges, relations, expand);
		const focus = new Set(focusIds);
		const nodes: GraphNode[] = ids
			.filter((id) => nodesById.has(id))
			.map((id) => ({ focus: focus.has(id), id }));
		const known = new Set(nodes.map((node) => node.id));
		const drawn = links.filter(
			(link) => known.has(link.source) && known.has(link.target),
		);
		// forceLink swaps ids for nodes, so it lays out copies.
		d3.forceSimulation<GraphNode>(nodes)
			.force(
				"link",
				d3
					.forceLink<GraphNode, { source: string; target: string }>(
						drawn.map((link) => ({ ...link })),
					)
					.id((node) => node.id)
					.distance(48),
			)
			// A short reach, so arguments with no edge between them stay close
			// instead of drifting off and shrinking the drawing.
			.force(
				"charge",
				d3.forceManyBody<GraphNode>().strength(-80).distanceMax(80),
			)
			.force("center", d3.forceCenter<GraphNode>(WIDTH / 2, HEIGHT / 2))
			.force("collide", d3.forceCollide<GraphNode>().radius(RADIUS * 2))
			.stop()
			.tick(300);
		const at = new Map(
			nodes.map((node) => [
				node.id,
				{ x: node.x ?? WIDTH / 2, y: node.y ?? HEIGHT / 2 },
			]),
		);
		// Frame the drawing on what it holds, so nothing piles up at an edge.
		const xs = [...at.values()].map((point) => point.x);
		const ys = [...at.values()].map((point) => point.y);
		const pad = RADIUS * 3;
		const minX = Math.min(...xs, WIDTH / 2) - pad;
		const minY = Math.min(...ys, HEIGHT / 2) - pad;
		const viewBox = [
			minX,
			minY,
			Math.max(...xs, WIDTH / 2) + pad - minX,
			Math.max(...ys, HEIGHT / 2) + pad - minY,
		].join(" ");
		return { at, links: drawn, nodes, viewBox };
	}, [edges, expand, focusIds, nodesById, relations]);

	return (
		<svg
			viewBox={layout.viewBox}
			className="h-auto max-h-96 w-full"
			role="img"
			aria-label={t`Connections`}
		>
			{layout.links.map((link) => {
				const a = layout.at.get(link.source);
				const b = layout.at.get(link.target);
				if (!a || !b) return null;
				return (
					<line
						key={`${link.source}-${link.target}-${link.relation}`}
						x1={a.x}
						y1={a.y}
						x2={b.x}
						y2={b.y}
						strokeWidth={1}
						strokeDasharray={link.relation ? "4,3" : undefined}
						style={{ stroke: "var(--map-edge)" }}
					/>
				);
			})}
			{layout.nodes.map((node) => {
				const graphNode = nodesById.get(node.id);
				const point = layout.at.get(node.id);
				if (!graphNode || !point) return null;
				const style = getNodeStyle(graphNode, { colorBy, darkMode });
				return (
					// biome-ignore lint/a11y/useSemanticElements: an SVG node has no button element
					<g
						key={node.id}
						role="button"
						tabIndex={0}
						aria-label={graphNode.label ?? node.id}
						className="cursor-pointer"
						onClick={() => onSelect(node.id)}
						onKeyDown={(event) => {
							if (event.key === "Enter" || event.key === " ") {
								event.preventDefault();
								onSelect(node.id);
							}
						}}
					>
						<title>{graphNode.label ?? node.id}</title>
						<circle
							cx={point.x}
							cy={point.y}
							r={node.focus ? RADIUS * 1.4 : RADIUS}
							fill={style.blend[0] ?? style.fill}
							strokeWidth={node.focus ? 2 : 1}
							style={{
								stroke: node.focus ? mapVars.text : style.stroke,
							}}
						/>
					</g>
				);
			})}
		</svg>
	);
};
