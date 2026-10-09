import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useElementSize } from "@mantine/hooks";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	conversationColor,
	MAP_NEUTRAL_GREY,
	resolveMapColor,
} from "../attributes";
import type { EvidenceGroup } from "../data/adapter";
import { getNodeStyle, mapHighlight, NODE_OUTLINE } from "../graph/nodeStyle";
import { d3, type SimulationNodeDatum } from "../renderers/d3";
import { RELATION_DASH, relationStroke } from "../renderers/relations";
import type { ColorBy, Edge, MapGraphNode, MapRelation } from "../types";
import { mapVars, prefersReducedMotion } from "./shared";

/** The drawing's height; its width is the sheet's. */
export const GRAPH_HEIGHT = 280;
/** Used until the sheet has been measured (and in tests, which measure nothing). */
const FALLBACK_WIDTH = 400;
const ARGUMENT_RADIUS = 7;
const FOCUS_RADIUS = 8;
const QUOTE_RADIUS = 3;
const PAD = 16;

type NeighbourLink = { source: string; target: string; relation: boolean };

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
): { ids: string[]; links: NeighbourLink[] } => {
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
	const links: NeighbourLink[] = [
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

/** One quote with the conversation it was spoken in. */
export type Voice = { text: string; group: EvidenceGroup };

/** An argument's quotes in reading order: the graph's leaves and the list's cards share it. */
export const voicesOf = (evidence: ReadonlyArray<EvidenceGroup>): Voice[] =>
	evidence.flatMap((group) => group.quotes.map((text) => ({ group, text })));

/** The id of an argument's nth quote, in the graph and in the list. */
export const quoteKey = (nodeId: string, index: number) => `${nodeId}#${index}`;

export type KnowledgeNode =
	| { kind: "argument"; id: string; nodeId: string; focus: boolean }
	| {
			kind: "quote";
			id: string;
			nodeId: string;
			index: number;
			voice: Voice;
	  };

export type KnowledgeLink = {
	source: string;
	target: string;
	kind: "quote" | "tree" | "relation";
};

export type KnowledgeGraphData = {
	nodes: KnowledgeNode[];
	links: KnowledgeLink[];
};

/**
 * The arguments as nodes and every quote of the focus as a leaf on its
 * argument. Tree edges and relationships join the arguments.
 */
export const knowledgeGraph = ({
	focusIds,
	expand,
	nodesById,
	edges,
	relations,
	evidenceFor,
}: {
	focusIds: ReadonlyArray<string>;
	/** True to draw the neighbours of the focus too (an argument). */
	expand: boolean;
	nodesById: ReadonlyMap<string, MapGraphNode>;
	edges: ReadonlyArray<Edge>;
	relations: ReadonlyArray<MapRelation>;
	evidenceFor: (nodeId: string) => EvidenceGroup[];
}): KnowledgeGraphData => {
	const { ids, links } = neighbourhood(focusIds, edges, relations, expand);
	const focus = new Set(focusIds);
	const nodes: KnowledgeNode[] = ids
		.filter((id) => nodesById.has(id))
		.map((id) => ({ focus: focus.has(id), id, kind: "argument", nodeId: id }));
	const known = new Set(nodes.map((node) => node.id));
	const graphLinks: KnowledgeLink[] = [];
	const seen = new Set<string>();
	for (const link of links) {
		if (!known.has(link.source) || !known.has(link.target)) continue;
		const kind = link.relation ? "relation" : "tree";
		const key = `${kind}:${[link.source, link.target].sort().join(":")}`;
		if (seen.has(key)) continue;
		seen.add(key);
		graphLinks.push({ kind, source: link.source, target: link.target });
	}
	for (const id of focusIds) {
		if (!known.has(id)) continue;
		voicesOf(evidenceFor(id)).forEach((voice, index) => {
			const key = quoteKey(id, index);
			nodes.push({ id: key, index, kind: "quote", nodeId: id, voice });
			graphLinks.push({ kind: "quote", source: id, target: key });
		});
	}
	return { links: graphLinks, nodes };
};

type Placed = SimulationNodeDatum & { id: string; quote: boolean };

type Point = { x: number; y: number };

/** How long a travel glides; none where the reader asks for less motion. */
export const GLIDE_MS = 300;

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * The map's force layout at the sheet's size: leaves close round their
 * argument, arguments apart, the whole held in the box. It is run to rest
 * before it is drawn, so the drawing holds still.
 *
 * With a `centre`, that node is pinned in the middle of the box and the fit
 * keeps it there. With a `seed` (the last layout), the nodes that were drawn
 * before start where they were, moved with the centre, so a travel shifts
 * the drawing rather than reshuffling it.
 */
export const layoutKnowledgeGraph = (
	graph: KnowledgeGraphData,
	width: number,
	height: number,
	{
		centre = null,
		seed,
	}: {
		centre?: string | null;
		seed?: ReadonlyMap<string, Point>;
	} = {},
): Map<string, Point> => {
	const cx = width / 2;
	const cy = height / 2;
	const pinned =
		centre && graph.nodes.some((node) => node.id === centre) ? centre : null;
	const from = pinned ? seed?.get(pinned) : undefined;
	const shiftX = from ? cx - from.x : 0;
	const shiftY = from ? cy - from.y : 0;
	const nodes: Placed[] = graph.nodes.map((node, index) => {
		const placed: Placed = { id: node.id, quote: node.kind === "quote" };
		const before = seed?.get(node.id);
		if (node.id === pinned) {
			placed.fx = cx;
			placed.fy = cy;
			placed.x = cx;
			placed.y = cy;
		} else if (before) {
			placed.x = before.x + shiftX;
			placed.y = before.y + shiftY;
		} else if (seed) {
			// New nodes start in a small spiral round the middle.
			const radius = 24 + 4 * index;
			placed.x = cx + radius * Math.cos(index * GOLDEN_ANGLE);
			placed.y = cy + radius * Math.sin(index * GOLDEN_ANGLE);
		}
		return placed;
	});
	if (nodes.length > 0) {
		d3.forceSimulation<Placed>(nodes)
			.force(
				"link",
				d3
					.forceLink<Placed, KnowledgeLink>(
						// forceLink swaps ids for nodes, so it lays out copies.
						graph.links.map((link) => ({ ...link })),
					)
					.id((node) => node.id)
					.distance((link) =>
						link.kind === "quote" ? 20 : link.kind === "tree" ? 64 : 80,
					)
					.strength((link) =>
						link.kind === "quote" ? 1 : link.kind === "tree" ? 0.4 : 0.2,
					),
			)
			.force(
				"charge",
				d3
					.forceManyBody<Placed>()
					.strength((node) => (node.quote ? -16 : -220))
					.distanceMax(220),
			)
			.force("x", d3.forceX<Placed>(cx).strength(0.04))
			.force("y", d3.forceY<Placed>(cy).strength(0.12))
			.force(
				"collide",
				d3
					.forceCollide<Placed>()
					.radius((node) => (node.quote ? QUOTE_RADIUS + 2 : FOCUS_RADIUS + 4)),
			)
			.stop()
			.tick(300);
	}
	// Fit by moving the points, never by scaling the drawing, so a hairline
	// stays a hairline and a dot keeps its size at any width.
	const xs = nodes.map((node) => node.x ?? cx);
	const ys = nodes.map((node) => node.y ?? cy);
	if (pinned) {
		// Scale about the middle, so the centre stays the centre.
		const reachX = Math.max(1, ...xs.map((x) => Math.abs(x - cx)));
		const reachY = Math.max(1, ...ys.map((y) => Math.abs(y - cy)));
		const scale = Math.min(
			1,
			(width / 2 - PAD) / reachX,
			(height / 2 - PAD) / reachY,
		);
		return new Map(
			nodes.map((node) => [
				node.id,
				{
					x: cx + ((node.x ?? cx) - cx) * scale,
					y: cy + ((node.y ?? cy) - cy) * scale,
				},
			]),
		);
	}
	const minX = Math.min(...xs, cx);
	const maxX = Math.max(...xs, cx);
	const minY = Math.min(...ys, cy);
	const maxY = Math.max(...ys, cy);
	const scale = Math.min(
		1,
		(width - PAD * 2) / Math.max(1, maxX - minX),
		(height - PAD * 2) / Math.max(1, maxY - minY),
	);
	const midX = (minX + maxX) / 2;
	const midY = (minY + maxY) / 2;
	return new Map(
		nodes.map((node) => [
			node.id,
			{
				x: cx + ((node.x ?? cx) - midX) * scale,
				y: cy + ((node.y ?? cy) - midY) * scale,
			},
		]),
	);
};

const ease = (k: number) => 1 - (1 - k) ** 3;

/**
 * The drawn positions, gliding from the last ones to `target` whenever the
 * graph changes: dots that stay move, new dots come out of `origin` (the dot
 * that was picked). A resize or reduced motion jumps.
 */
const useGlide = (
	target: Map<string, Point>,
	graph: KnowledgeGraphData,
	origin: string | null,
): Map<string, Point> => {
	const [drawn, setDrawn] = useState(target);
	const drawnRef = useRef(target);
	const graphRef = useRef(graph);
	useEffect(() => {
		const from = drawnRef.current;
		const travelled = graphRef.current !== graph;
		graphRef.current = graph;
		if (from === target) return;
		if (
			!travelled ||
			prefersReducedMotion() ||
			typeof requestAnimationFrame !== "function"
		) {
			drawnRef.current = target;
			setDrawn(target);
			return;
		}
		const out = (origin && from.get(origin)) || null;
		const start = new Map(
			[...target].map(([id, point]) => [id, from.get(id) ?? out ?? point]),
		);
		// Every dot is drawn from the first frame, where the glide starts it.
		drawnRef.current = start;
		setDrawn(start);
		const began = performance.now();
		let frame = 0;
		const step = (now: number) => {
			const k = Math.min(1, (now - began) / GLIDE_MS);
			const e = ease(k);
			const next =
				k >= 1
					? target
					: new Map(
							[...target].map(([id, point]) => {
								const a = start.get(id) ?? point;
								return [
									id,
									{
										x: a.x + (point.x - a.x) * e,
										y: a.y + (point.y - a.y) * e,
									},
								];
							}),
						);
			drawnRef.current = next;
			setDrawn(next);
			if (k < 1) frame = requestAnimationFrame(step);
		};
		frame = requestAnimationFrame(step);
		return () => {
			cancelAnimationFrame(frame);
			// Interrupted mid-glide: the next one starts where this one stopped.
		};
	}, [target, graph, origin]);
	return drawn;
};

/**
 * The knowledge graph of a cluster or an argument, drawn with the map's own
 * engine: its force layout, its colours and its hairlines. Arguments are dots
 * in the map's colours; every quote is a small leaf in its conversation's
 * colour. Pointing at a dot names it under the drawing; picking one hands it
 * to the sheet. When the focus moves to another argument, the drawing glides
 * to put it in the middle.
 */
export const KnowledgeGraph = ({
	graph,
	nodesById,
	colorBy,
	darkMode,
	marked,
	centre = null,
	onPick,
}: {
	graph: KnowledgeGraphData;
	nodesById: ReadonlyMap<string, MapGraphNode>;
	colorBy: ColorBy;
	darkMode: boolean;
	/** The node picked last, ringed. */
	marked: string | null;
	/** The argument held in the middle of the drawing, if there is one. */
	centre?: string | null;
	onPick: (node: KnowledgeNode) => void;
}) => {
	const { ref, width: measured } = useElementSize<HTMLDivElement>();
	const width = Math.round(measured) || FALLBACK_WIDTH;
	// The last layout seeds the next, so a travel moves the drawing on.
	const lastLayout = useRef<Map<string, Point> | undefined>(undefined);
	const target = useMemo(() => {
		const next = layoutKnowledgeGraph(graph, width, GRAPH_HEIGHT, {
			centre,
			seed: lastLayout.current,
		});
		lastLayout.current = next;
		return next;
	}, [graph, width, centre]);
	const at = useGlide(target, graph, centre);
	const [active, setActive] = useState<string | null>(null);
	const highlight = mapHighlight(darkMode);
	const byId = useMemo(
		() => new Map(graph.nodes.map((node) => [node.id, node] as const)),
		[graph.nodes],
	);
	const labelOf = (node: KnowledgeNode): string =>
		node.kind === "argument"
			? (nodesById.get(node.nodeId)?.label ?? node.nodeId)
			: node.voice.text;
	const shown = active ? byId.get(active) : undefined;
	// An argument drawn with its neighbours stands out from them.
	const hasNeighbours = graph.nodes.some(
		(node) => node.kind === "argument" && !node.focus,
	);

	const linkStyle = (kind: KnowledgeLink["kind"]) =>
		kind === "relation"
			? {
					stroke: relationStroke(darkMode),
					strokeDasharray: RELATION_DASH,
					strokeOpacity: 0.75,
				}
			: {
					stroke: "var(--map-edge)",
					strokeDasharray: undefined,
					strokeOpacity: kind === "quote" ? 0.6 : 1,
				};

	return (
		<div ref={ref} className="space-y-2" data-testid="knowledge-graph">
			{/* biome-ignore lint/a11y/useSemanticElements: an SVG drawing of buttons has no fieldset */}
			<svg
				width="100%"
				height={GRAPH_HEIGHT}
				viewBox={`0 0 ${width} ${GRAPH_HEIGHT}`}
				role="group"
				aria-label={t`Knowledge graph`}
				className="block"
			>
				{graph.links.map((link) => {
					const a = at.get(link.source);
					const b = at.get(link.target);
					if (!a || !b) return null;
					const style = linkStyle(link.kind);
					return (
						<line
							key={`${link.kind}-${link.source}-${link.target}`}
							data-link={link.kind}
							x1={a.x}
							y1={a.y}
							x2={b.x}
							y2={b.y}
							strokeWidth={1}
							strokeLinecap="round"
							strokeDasharray={style.strokeDasharray}
							strokeOpacity={style.strokeOpacity}
							style={{ stroke: style.stroke }}
						/>
					);
				})}
				{graph.nodes.map((node) => {
					const point = at.get(node.id);
					if (!point) return null;
					const label = labelOf(node);
					let fill: string;
					let radius: number;
					if (node.kind === "argument") {
						const mapNode = nodesById.get(node.nodeId);
						const style = mapNode
							? getNodeStyle(mapNode, { colorBy, darkMode })
							: null;
						fill = style ? (style.blend[0] ?? style.fill) : MAP_NEUTRAL_GREY;
						radius =
							node.focus && hasNeighbours ? FOCUS_RADIUS : ARGUMENT_RADIUS;
					} else {
						const slot = node.voice.group.slot;
						fill =
							slot === null
								? MAP_NEUTRAL_GREY
								: resolveMapColor(conversationColor(slot), darkMode);
						radius = QUOTE_RADIUS;
					}
					const ringed = node.id === marked || node.id === active;
					return (
						// biome-ignore lint/a11y/useSemanticElements: an SVG node has no button element
						<g
							key={node.id}
							role="button"
							tabIndex={0}
							aria-label={label}
							aria-pressed={node.id === marked}
							aria-current={node.id === centre || undefined}
							data-node-kind={node.kind}
							data-node-id={node.id}
							className="cursor-pointer outline-none"
							onClick={() => onPick(node)}
							onKeyDown={(event) => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									onPick(node);
								}
							}}
							onPointerEnter={() => setActive(node.id)}
							onPointerLeave={() =>
								setActive((current) => (current === node.id ? null : current))
							}
							onFocus={() => setActive(node.id)}
							onBlur={() =>
								setActive((current) => (current === node.id ? null : current))
							}
						>
							{/* A wider, unpainted target, so a 3px leaf is easy to pick. */}
							<circle
								cx={point.x}
								cy={point.y}
								r={Math.max(radius + 4, 8)}
								fill="transparent"
							/>
							<circle
								cx={point.x}
								cy={point.y}
								r={radius}
								fill={fill}
								strokeWidth={1}
								style={{ stroke: NODE_OUTLINE }}
							/>
							{ringed && (
								<circle
									cx={point.x}
									cy={point.y}
									r={radius + 3}
									fill="none"
									strokeWidth={node.id === marked ? 1.5 : 1}
									stroke={highlight}
									pointerEvents="none"
									data-testid={node.id === marked ? "graph-mark" : undefined}
								/>
							)}
						</g>
					);
				})}
			</svg>
			{/* One line under the drawing names what is pointed at; a room that
			    cannot hover reads the same words in the panel below. */}
			<p
				className="line-clamp-2 min-h-[2lh] text-xs"
				style={{ color: shown ? mapVars.text : "var(--map-muted)" }}
				aria-live="polite"
				data-testid="graph-caption"
			>
				{shown ? (
					shown.kind === "quote" ? (
						<>
							{`“${shown.voice.text}”`}
							<span style={{ color: "var(--map-muted)" }}>
								{` · ${shown.voice.group.label}`}
							</span>
						</>
					) : (
						labelOf(shown)
					)
				) : (
					<Trans>
						Pick an argument to go to it, or a quote to find it below.
					</Trans>
				)}
			</p>
		</div>
	);
};
