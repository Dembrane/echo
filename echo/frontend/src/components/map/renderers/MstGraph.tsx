import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { GearIcon } from "@phosphor-icons/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	createMstRepulsionForce,
	MST_FORCE_DEFAULTS,
	type MstForceParams,
	type MstRepulsionForce,
	mstLinkDistance,
	mstViewportForces,
} from "../graph/forces";
import { calculateInitialPositions } from "../graph/layout";
import {
	adjacencyOf,
	buildMST,
	buildRootedTree,
	descendantsOf,
	mstHopDistances,
} from "../graph/mst";
import { newestNodeIds } from "../graph/nodeSet";
import { MAP_EDGE_GREY, MAP_HIGHLIGHT } from "../graph/nodeStyle";
import { type EdgeCounts, selectMstEdges } from "../layout/edgeBudget";
import {
	useMapInteraction,
	useMapInteractionStore,
} from "../state/interactionStore";
import type { ColorBy, Edge, MapGraphNode, MapRelation } from "../types";
import {
	AUTO_FIT_EVERY_TICKS,
	armAutoFit,
	autoFit,
	cancelAutoFit,
	createAutoFitState,
	FIT_PADDING_SCALE,
} from "./autoFit";
import {
	type BaseType,
	d3,
	type ForceCenter,
	type ForceCollide,
	type ForceLink,
	type ForceManyBody,
	type Selection,
	type Simulation,
	type SimulationNodeDatum,
	type ZoomBehavior,
} from "./d3";
import {
	EMPTY_NODE_IDS,
	type GeometryBuild,
	useContainerSize,
	useNodeRadius,
	useNodeStyleLookup,
	usePulseTimer,
	useReleaseOwnedHighlight,
	useRendererGeometry,
	useReportEdgeCounts,
} from "./hooks";
import { MapChromeButton, MapSettingsPanel, RangeSetting } from "./MapChrome";
import {
	drawRelationPositions,
	joinRelationLines,
	type RelationLineSelection,
} from "./relations";

/**
 * Organic MST graph: builds a minimum spanning tree over the nodes' cosine
 * distances and renders it as a breathing d3 force graph.
 *
 * The simulation is created once, when nodes first arrive, and then updated
 * in place: a new node set, a resize, a force parameter change and a node
 * size change adjust the running forces and keep node elements, positions
 * and the zoom transform.
 */

interface InternalNode extends SimulationNodeDatum {
	id: string;
}

type SimulationLink = {
	source: string | InternalNode;
	target: string | InternalNode;
	distance: number;
};

type LinkSelection = Selection<
	SVGLineElement,
	SimulationLink,
	BaseType,
	unknown
>;
type CircleSelection = Selection<
	SVGCircleElement,
	InternalNode,
	SVGGElement,
	unknown
>;

export interface MstGraphProps {
	nodes: MapGraphNode[];
	colorBy?: ColorBy;
	darkMode?: boolean;
	selectedId?: string | null;
	onNodeClick?: (nodeId: string) => void;
	onNodeHover?: (node: MapGraphNode | null) => void;
	timerActive?: boolean;
	timerProgress?: number;
	className?: string;
	// Optional style overrides
	/** Base node radius; each node's size scale multiplies it. */
	nodeRadius?: number;
	edgeColor?: string;
	backgroundColor?: string;
	recentNodeIds?: string[];
	// Highlighting mode
	highlightMode?: "radius" | "downstream";
	/**
	 * Tree edges over `nodes`: `mstEdges` from useMapGeometry, or edges the
	 * caller built. Without them the graph builds its own MST.
	 */
	mstEdges?: Edge[];
	/**
	 * Explicit relationships between nodes (revision ids). Drawn as dashed
	 * overlays; they never enter the tree, the forces or the walk.
	 */
	relations?: MapRelation[];
	/**
	 * Visible-edge budget. Every tree edge is always drawn; relationship
	 * overlays use what is left.
	 */
	edgeLimit: number;
	/** Draw every relationship within the budget, not only the selected node's. */
	showRelationships?: boolean;
	/** Drawn and available connection counts, called when they change. */
	onEdgeCounts?: (counts: EdgeCounts) => void;
}

/** Edge stroke; follows --map-edge when the parent sets it. */
const DEFAULT_EDGE_COLOR = `var(--map-edge, ${MAP_EDGE_GREY})`;

export const DEFAULT_WALK_INTERVAL_MS = 30000;

const EMPTY_RELATIONS: MapRelation[] = [];

/** Collision radius as a multiple of the node's own radius. */
const COLLISION_SCALE = 1.25;

/** The synchronous path: the tree built here when no layout result is given. */
const buildOwnGeometry = (
	nodes: ReadonlyArray<MapGraphNode>,
): GeometryBuild => ({ mstEdges: buildMST(nodes), neighbours: null });

const endpointNode = (end: string | InternalNode): InternalNode | undefined =>
	typeof end === "string" ? undefined : end;

const endpointKey = (end: string | InternalNode): string =>
	typeof end === "string" ? end : end.id;

/**
 * forceLink swaps id endpoints for node objects. Put the ids back so the
 * links resolve against the simulation's current node objects.
 */
const resetLinkEndpoints = (links: SimulationLink[]) => {
	for (const link of links) {
		link.source = endpointKey(link.source);
		link.target = endpointKey(link.target);
	}
};

const drawPositions = (
	links: LinkSelection | null,
	relationLines: RelationLineSelection | null,
	circles: CircleSelection | null,
	nodeById: ReadonlyMap<string, InternalNode>,
) => {
	links
		?.attr("x1", (d) => endpointNode(d.source)?.x ?? null)
		.attr("y1", (d) => endpointNode(d.source)?.y ?? null)
		.attr("x2", (d) => endpointNode(d.target)?.x ?? null)
		.attr("y2", (d) => endpointNode(d.target)?.y ?? null);
	drawRelationPositions(relationLines, nodeById);
	circles?.attr("cx", (d) => d.x ?? 0).attr("cy", (d) => d.y ?? 0);
};

/** The forces the running simulation was last configured with. */
type AppliedForces = {
	width: number;
	height: number;
	params: MstForceParams;
	/** Node radii the collision force was initialised with. */
	radiusSignature: string;
};

const forceOf = <F,>(
	simulation: Simulation<InternalNode>,
	name: string,
): F | undefined => simulation.force(name) as F | undefined;

export const MstGraph = ({
	nodes,
	colorBy = "none",
	darkMode = false,
	selectedId,
	onNodeClick,
	onNodeHover,
	timerActive = false,
	timerProgress = 0,
	className = "",
	nodeRadius = 6,
	edgeColor = DEFAULT_EDGE_COLOR,
	backgroundColor = "transparent",
	recentNodeIds = EMPTY_NODE_IDS,
	highlightMode = "radius",
	mstEdges: providedMstEdges,
	relations = EMPTY_RELATIONS,
	edgeLimit,
	showRelationships = false,
	onEdgeCounts,
}: MstGraphProps) => {
	const containerRef = useRef<HTMLDivElement>(null);
	const svgRef = useRef<SVGSVGElement>(null);
	const simulationRef = useRef<Simulation<InternalNode> | null>(null);
	const gRef = useRef<Selection<SVGGElement, unknown, null, undefined> | null>(
		null,
	);
	// Cursor ring and timer arc, outside the zoomed group so they stay on the
	// cursor at screen size while the map zooms and pans
	const overlayRef = useRef<Selection<
		SVGGElement,
		unknown,
		null,
		undefined
	> | null>(null);
	const zoomRef = useRef<ZoomBehavior<SVGSVGElement> | null>(null);
	const linkSelectionRef = useRef<LinkSelection | null>(null);
	const relationSelectionRef = useRef<RelationLineSelection | null>(null);
	const circleSelectionRef = useRef<CircleSelection | null>(null);
	const pulseSelectionRef = useRef<CircleSelection | null>(null);
	const startPulse = usePulseTimer(pulseSelectionRef);
	const appliedRef = useRef<AppliedForces | null>(null);
	const autoFitRef = useRef(createAutoFitState());

	const { size: dimensions, sizeRef, measure } = useContainerSize(containerRef);
	const recentNodeIdsSet = useMemo(
		() => new Set(recentNodeIds),
		[recentNodeIds],
	);
	const styleOf = useNodeStyleLookup(nodes, colorBy, darkMode);
	const { radiusOf, signature: radiusSignature } = useNodeRadius(
		nodes,
		nodeRadius,
	);
	const nodeById = useMemo(
		() => new Map(nodes.map((node) => [node.id, node])),
		[nodes],
	);

	// Latest values for d3 callbacks that outlive the render that attached them
	const nodeByIdRef = useRef(nodeById);
	nodeByIdRef.current = nodeById;
	const nodeRadiusRef = useRef(nodeRadius);
	nodeRadiusRef.current = nodeRadius;
	const radiusOfRef = useRef(radiusOf);
	radiusOfRef.current = radiusOf;
	const radiusSignatureRef = useRef(radiusSignature);
	radiusSignatureRef.current = radiusSignature;
	const onNodeClickRef = useRef(onNodeClick);
	onNodeClickRef.current = onNodeClick;
	const onNodeHoverRef = useRef(onNodeHover);
	onNodeHoverRef.current = onNodeHover;
	const highlightModeRef = useRef(highlightMode);
	highlightModeRef.current = highlightMode;

	const [cursorPosition, setCursorPosition] = useState<{
		x: number;
		y: number;
	} | null>(null);
	const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
	// Local state for immediate visual feedback
	const [localHighlightedNodeIds, setLocalHighlightedNodeIds] = useState<
		Set<string>
	>(new Set());
	const [localHighlightedNodesDistance, setLocalHighlightedNodesDistance] =
		useState<Map<string, number>>(new Map());
	// Store state for triggering calculations/timer (debounced), read by parent components
	const interactionStore = useMapInteractionStore();
	const setHighlightedNodeIds = useMapInteraction(
		(state) => state.setHighlightedNodeIds,
	);
	const setHighlightedNodesDistance = useMapInteraction(
		(state) => state.setHighlightedNodesDistance,
	);
	const storeHighlightedNodeIds = useMapInteraction(
		(state) => state.highlightedNodeIds,
	);
	const storeHighlightedNodesDistance = useMapInteraction(
		(state) => state.highlightedNodesDistance,
	);
	const mouseMoveTimeoutRef = useRef<number | null>(null);

	// Combine local and store state for rendering (prevents infinite loops with stable references)
	const combinedHighlightedNodeIds = useMemo(
		() => new Set([...localHighlightedNodeIds, ...storeHighlightedNodeIds]),
		[localHighlightedNodeIds, storeHighlightedNodeIds],
	);
	const combinedHighlightedNodesDistance = useMemo(() => {
		const combined = new Map(storeHighlightedNodesDistance);
		localHighlightedNodesDistance.forEach((value, key) => {
			combined.set(key, value);
		});
		return combined;
	}, [localHighlightedNodesDistance, storeHighlightedNodesDistance]);

	// Editable force parameters
	const [showSettings, setShowSettings] = useState(false);
	const [linkDistanceConstant, setLinkDistanceConstant] = useState(
		MST_FORCE_DEFAULTS.link.constant,
	);
	const [linkDistanceLinear, setLinkDistanceLinear] = useState(
		MST_FORCE_DEFAULTS.link.linear,
	);
	const [linkDistanceQuadratic, setLinkDistanceQuadratic] = useState(
		MST_FORCE_DEFAULTS.link.quadratic,
	);
	const [chargeStrength, setChargeStrength] = useState(
		MST_FORCE_DEFAULTS.chargeStrength,
	);
	const [mstRepulsionCoeff, setMstRepulsionCoeff] = useState(
		MST_FORCE_DEFAULTS.mstRepulsionCoeff,
	);

	const params = useMemo<MstForceParams>(
		() => ({
			chargeStrength,
			link: {
				constant: linkDistanceConstant,
				linear: linkDistanceLinear,
				quadratic: linkDistanceQuadratic,
			},
			mstRepulsionCoeff,
		}),
		[
			chargeStrength,
			linkDistanceConstant,
			linkDistanceLinear,
			linkDistanceQuadratic,
			mstRepulsionCoeff,
		],
	);
	const paramsRef = useRef(params);
	paramsRef.current = params;

	const resetToDefaults = useCallback(() => {
		setLinkDistanceConstant(MST_FORCE_DEFAULTS.link.constant);
		setLinkDistanceLinear(MST_FORCE_DEFAULTS.link.linear);
		setLinkDistanceQuadratic(MST_FORCE_DEFAULTS.link.quadratic);
		setChargeStrength(MST_FORCE_DEFAULTS.chargeStrength);
		setMstRepulsionCoeff(MST_FORCE_DEFAULTS.mstRepulsionCoeff);
	}, []);

	// Geometry, once per node set (ids and vectors): the layout result when
	// given and matching these nodes, otherwise the last one that did
	const geometry = useRendererGeometry(
		nodes,
		{ mstEdges: providedMstEdges },
		buildOwnGeometry,
	);
	const geometryNodes = geometry.nodes;
	const mstEdges = geometry.mstEdges;
	const centerId = geometry.centerId;

	const mstDistances = useMemo(
		() => mstHopDistances(geometryNodes, mstEdges),
		[geometryNodes, mstEdges],
	);
	const rootedTree = useMemo(
		() => buildRootedTree(geometryNodes, mstEdges, centerId),
		[geometryNodes, mstEdges, centerId],
	);
	// Radial layout at a fixed viewport size (not dependent on dimensions)
	const initialPositions = useMemo(
		() =>
			calculateInitialPositions(geometryNodes, mstEdges, 800, 600, centerId),
		[geometryNodes, mstEdges, centerId],
	);

	// Defensive copy of nodes to prevent D3 mutations from affecting React state
	const simulationNodes = useMemo(
		() => geometryNodes.map((node): InternalNode => ({ id: node.id })),
		[geometryNodes],
	);
	const simulationNodeById = useMemo(
		() => new Map(simulationNodes.map((node) => [node.id, node])),
		[simulationNodes],
	);
	const simulationNodeByIdRef = useRef(simulationNodeById);
	simulationNodeByIdRef.current = simulationNodeById;
	const simulationLinks = useMemo(
		() =>
			mstEdges.map(
				(edge): SimulationLink => ({
					distance: edge.distance,
					source: edge.source,
					target: edge.target,
				}),
			),
		[mstEdges],
	);

	// Lines inside the visible-edge budget: the whole tree, then relationships
	const placedNodeIds = useMemo(
		() => new Set(geometryNodes.map((node) => node.id)),
		[geometryNodes],
	);
	const edgeSelection = useMemo(
		() =>
			selectMstEdges({
				edgeLimit,
				nodeIds: placedNodeIds,
				relations,
				selectedId,
				showRelationships,
				treeEdges: mstEdges,
			}),
		[
			edgeLimit,
			placedNodeIds,
			relations,
			selectedId,
			showRelationships,
			mstEdges,
		],
	);
	useReportEdgeCounts(edgeSelection.counts, onEdgeCounts);

	// Radius mode: highlight nodes near the cursor
	useEffect(() => {
		if (!svgRef.current) return;

		const svg = svgRef.current;
		const HIGHLIGHT_RADIUS = 50;

		if (highlightMode === "radius") {
			// Immediate visual feedback, debounced timer/calculations
			const handleMouseMove = (event: MouseEvent) => {
				const rect = svg.getBoundingClientRect();
				const x = event.clientX - rect.left;
				const y = event.clientY - rect.top;

				setCursorPosition({ x, y });

				const simulation = simulationRef.current;
				if (!simulation) {
					setLocalHighlightedNodeIds(new Set());
					setLocalHighlightedNodesDistance(new Map());
					return;
				}

				const highlighted = new Set<string>();
				const distances = new Map<string, number>();
				const transform = d3.zoomTransform(svg);

				for (const node of simulation.nodes()) {
					if (node.x !== undefined && node.y !== undefined) {
						// Node position in screen coordinates
						const screenX = node.x * transform.k + transform.x;
						const screenY = node.y * transform.k + transform.y;
						// A larger node reaches the cursor sooner by its extra radius
						const extraRadius =
							Math.max(
								0,
								radiusOfRef.current(node.id) - nodeRadiusRef.current,
							) * transform.k;
						const distance = Math.max(
							0,
							Math.hypot(screenX - x, screenY - y) - extraRadius,
						);

						if (distance <= HIGHLIGHT_RADIUS) {
							highlighted.add(node.id);
							// 0 = at cursor, 1 = at edge of radius
							distances.set(node.id, distance / HIGHLIGHT_RADIUS);
						}
					}
				}

				setLocalHighlightedNodeIds(highlighted);
				setLocalHighlightedNodesDistance(distances);

				if (mouseMoveTimeoutRef.current !== null) {
					window.clearTimeout(mouseMoveTimeoutRef.current);
				}

				// Don't trample a history-driven highlight while the cursor is over
				// empty space; keep it until the user hovers nodes or leaves the SVG.
				const currentSource = interactionStore.getState().highlightSource;
				if (currentSource === "history" && highlighted.size === 0) {
					return;
				}

				// Clear store state immediately (stops timer)
				setHighlightedNodeIds(new Set(), {
					isPreview: false,
					source: "mst-hover",
				});
				setHighlightedNodesDistance(new Map());

				// Publish to the store after 0.5s of no movement (triggers timer/calculations)
				mouseMoveTimeoutRef.current = window.setTimeout(() => {
					setHighlightedNodeIds(highlighted, {
						isPreview: false,
						source: "mst-hover",
					});
					setHighlightedNodesDistance(distances);
				}, 500);
			};

			const handleMouseLeave = () => {
				if (mouseMoveTimeoutRef.current !== null) {
					window.clearTimeout(mouseMoveTimeoutRef.current);
					mouseMoveTimeoutRef.current = null;
				}

				setCursorPosition(null);
				setLocalHighlightedNodeIds(new Set());
				setLocalHighlightedNodesDistance(new Map());
				// Only clear the store if this panel's hover set the highlight.
				// History-driven selections persist until the user toggles them off.
				const currentSource = interactionStore.getState().highlightSource;
				if (currentSource === "mst-hover") {
					setHighlightedNodeIds(new Set(), {
						isPreview: false,
						source: "mst-hover",
					});
					setHighlightedNodesDistance(new Map());
				}
			};

			svg.addEventListener("mousemove", handleMouseMove);
			svg.addEventListener("mouseleave", handleMouseLeave);

			return () => {
				if (mouseMoveTimeoutRef.current !== null) {
					window.clearTimeout(mouseMoveTimeoutRef.current);
				}
				svg.removeEventListener("mousemove", handleMouseMove);
				svg.removeEventListener("mouseleave", handleMouseLeave);
			};
		}
	}, [
		setHighlightedNodeIds,
		setHighlightedNodesDistance,
		highlightMode,
		interactionStore,
	]);

	// Downstream mode: highlight the hovered node and its subtree
	useEffect(() => {
		if (highlightMode !== "downstream") return;

		// A hovered node that left the tree (or an empty tree) is no hover. Its
		// element went without a mouseleave, so forget it: it must not light up
		// again when the node comes back.
		const inTree =
			hoveredNodeId !== null && rootedTree.parent.has(hoveredNodeId);
		if (hoveredNodeId !== null && !inTree) {
			setHoveredNodeId(null);
		}

		if (!hoveredNodeId || !inTree) {
			// Only clear if this panel set the highlight.
			const currentSource = interactionStore.getState().highlightSource;
			if (currentSource === "mst-hover") {
				setHighlightedNodeIds(new Set(), {
					isPreview: false,
					source: "mst-hover",
				});
				setHighlightedNodesDistance(new Map());
			}
			return;
		}

		const { ids, distances } = descendantsOf(hoveredNodeId, rootedTree);

		setHighlightedNodeIds(ids, { isPreview: false, source: "mst-hover" });
		setHighlightedNodesDistance(distances);
	}, [
		hoveredNodeId,
		highlightMode,
		rootedTree,
		setHighlightedNodeIds,
		setHighlightedNodesDistance,
		interactionStore,
	]);

	// Clear this panel's hover highlight when its nodes leave or the map unmounts
	useReleaseOwnedHighlight("mst-hover", geometryNodes);

	// SVG group and zoom, created once per mount
	useEffect(() => {
		const svgElement = svgRef.current;
		if (!svgElement) return;

		const svg = d3.select(svgElement);
		const g = svg.append("g");
		g.append("g").attr("class", "links-group");
		g.append("g").attr("class", "relations-group");
		g.append("g")
			.attr("class", "nodes-group")
			.append("g")
			.attr("class", "circle-nodes");
		gRef.current = g;
		overlayRef.current = svg
			.append("g")
			.attr("class", "cursor-layer")
			.attr("pointer-events", "none");

		const zoom = d3
			.zoom<SVGSVGElement>()
			.scaleExtent([0.1, 4])
			// The measured panel, not the SVG's own attributes
			.extent(() => [
				[0, 0],
				[sizeRef.current.width, sizeRef.current.height],
			])
			.on("zoom", (event) => {
				g.attr("transform", event.transform.toString());
				if (event.sourceEvent) autoFitRef.current.userZoomed = true;
			});
		svg.call(zoom);
		zoomRef.current = zoom;

		return () => {
			cancelAutoFit(svgElement, autoFitRef.current);
			svg.on(".zoom", null);
			svg.selectAll("*").remove();
			gRef.current = null;
			overlayRef.current = null;
			zoomRef.current = null;
			linkSelectionRef.current = null;
			relationSelectionRef.current = null;
			circleSelectionRef.current = null;
			pulseSelectionRef.current = null;
		};
	}, [sizeRef]);

	// Stop the simulation on unmount
	useEffect(() => {
		return () => {
			simulationRef.current?.stop().on("tick", null);
			simulationRef.current = null;
			appliedRef.current = null;
		};
	}, []);

	// Simulation: created when nodes first arrive, updated in place afterwards
	useEffect(() => {
		if (!gRef.current) return;
		const existing = simulationRef.current;

		if (simulationNodes.length === 0) {
			if (existing) {
				existing.stop().on("tick", null);
				simulationRef.current = null;
				appliedRef.current = null;
				cancelAutoFit(svgRef.current, autoFitRef.current);
			}
			return;
		}

		const size = measure();
		const currentParams = paramsRef.current;
		const viewport = mstViewportForces(
			size.width,
			size.height,
			simulationNodes.length,
		);
		const linkDistance = (link: SimulationLink) =>
			mstLinkDistance(link.distance, currentParams.link, viewport.k);

		resetLinkEndpoints(simulationLinks);

		if (existing) {
			// New node set: carry positions over and adjust the forces. A running
			// auto-fit was aimed at the old set, so stop it and fit afresh, in
			// either direction while the new set settles.
			cancelAutoFit(svgRef.current, autoFitRef.current);
			armAutoFit(autoFitRef.current);
			const previous = new Map(existing.nodes().map((node) => [node.id, node]));
			for (const node of simulationNodes) {
				const old = previous.get(node.id);
				if (old && old !== node) {
					node.x = old.x;
					node.y = old.y;
					node.vx = old.vx;
					node.vy = old.vy;
				} else if (!old) {
					const pos = initialPositions.get(node.id);
					node.x = pos?.x ?? size.width / 2;
					node.y = pos?.y ?? size.height / 2;
				}
			}

			const linkForce = forceOf<ForceLink<InternalNode, SimulationLink>>(
				existing,
				"link",
			);
			// Empty the links first so the old ones never resolve against the new nodes
			linkForce?.links([]);
			existing.nodes(simulationNodes);
			linkForce?.links(simulationLinks).distance(linkDistance);
			forceOf<ForceManyBody<InternalNode>>(existing, "charge")?.distanceMax(
				viewport.chargeDistanceMax,
			);
			forceOf<ForceCenter<InternalNode>>(existing, "center")
				?.x(viewport.centerX)
				.y(viewport.centerY);
			forceOf<MstRepulsionForce<InternalNode>>(existing, "mstRepulsion")
				?.setDistances(mstDistances)
				.setMaxDistance(viewport.mstRepulsionMaxDistance);

			existing.alpha(Math.max(existing.alpha(), 0.3)).restart();
		} else {
			for (const node of simulationNodes) {
				const pos = initialPositions.get(node.id);
				node.x = pos?.x ?? 400;
				node.y = pos?.y ?? 300;
			}

			const simulation = d3
				.forceSimulation<InternalNode>(simulationNodes)
				.force(
					"link",
					d3
						.forceLink<InternalNode, SimulationLink>(simulationLinks)
						.id((d) => d.id)
						.distance(linkDistance)
						.strength(1),
				)
				.force(
					"charge",
					d3
						.forceManyBody<InternalNode>()
						.strength(currentParams.chargeStrength)
						.distanceMax(viewport.chargeDistanceMax),
				)
				.force(
					"center",
					d3
						.forceCenter<InternalNode>(viewport.centerX, viewport.centerY)
						.strength(1),
				)
				.force(
					"collision",
					d3
						.forceCollide<InternalNode>()
						.radius((d) => radiusOfRef.current(d.id) * COLLISION_SCALE),
				)
				.force(
					"mstRepulsion",
					createMstRepulsionForce<InternalNode>(
						mstDistances,
						currentParams.mstRepulsionCoeff,
					).setMaxDistance(viewport.mstRepulsionMaxDistance),
				);

			// alphaTarget 0.01 keeps a gentle "breathing" but allows settling
			simulation.alpha(0.8).alphaDecay(0.003).alphaTarget(0.01);

			simulation.on("tick", () => {
				// Adaptive charge: strong repulsion early (3x), 1x as alpha decays
				const alpha = simulation.alpha();
				if (alpha > 0.01) {
					forceOf<ForceManyBody<InternalNode>>(simulation, "charge")?.strength(
						paramsRef.current.chargeStrength * (1 + (alpha / 0.8) * 2),
					);
				}

				drawPositions(
					linkSelectionRef.current,
					relationSelectionRef.current,
					circleSelectionRef.current,
					simulationNodeByIdRef.current,
				);

				const fitState = autoFitRef.current;
				fitState.tick++;
				if (fitState.tick % AUTO_FIT_EVERY_TICKS === 0) {
					autoFit({
						animate: true,
						nodes: simulation.nodes(),
						padding: (node) => radiusOfRef.current(node.id) * FIT_PADDING_SCALE,
						size: sizeRef.current,
						state: fitState,
						svgElement: svgRef.current,
						zoom: zoomRef.current,
					});
				}
			});

			simulationRef.current = simulation;

			// Fit the first layout at once, not on a later tick: a background tab
			// may not tick for a long while
			armAutoFit(autoFitRef.current);
			autoFit({
				animate: false,
				nodes: simulationNodes,
				padding: (node) => radiusOfRef.current(node.id) * FIT_PADDING_SCALE,
				size,
				state: autoFitRef.current,
				svgElement: svgRef.current,
				zoom: zoomRef.current,
			});
		}

		appliedRef.current = {
			height: size.height,
			params: currentParams,
			radiusSignature: radiusSignatureRef.current,
			width: size.width,
		};
	}, [
		simulationNodes,
		simulationLinks,
		mstDistances,
		initialPositions,
		measure,
		sizeRef,
	]);

	// Force parameters: update the running forces in place
	useEffect(() => {
		const simulation = simulationRef.current;
		const applied = appliedRef.current;
		if (!simulation || !applied || applied.params === params) return;

		const viewport = mstViewportForces(
			applied.width,
			applied.height,
			simulation.nodes().length,
		);
		forceOf<ForceManyBody<InternalNode>>(simulation, "charge")?.strength(
			params.chargeStrength,
		);
		forceOf<ForceLink<InternalNode, SimulationLink>>(
			simulation,
			"link",
		)?.distance((link) =>
			mstLinkDistance(link.distance, params.link, viewport.k),
		);
		forceOf<MstRepulsionForce<InternalNode>>(
			simulation,
			"mstRepulsion",
		)?.setStrength(params.mstRepulsionCoeff);

		applied.params = params;
		simulation.alpha(Math.max(simulation.alpha(), 0.5)).restart();
	}, [params]);

	// Resize: move the centre and rescale the viewport-dependent forces in place
	useEffect(() => {
		const simulation = simulationRef.current;
		const applied = appliedRef.current;
		if (!simulation || !applied) return;
		if (
			applied.width === dimensions.width &&
			applied.height === dimensions.height
		) {
			return;
		}

		const viewport = mstViewportForces(
			dimensions.width,
			dimensions.height,
			simulation.nodes().length,
		);
		forceOf<ForceCenter<InternalNode>>(simulation, "center")
			?.x(viewport.centerX)
			.y(viewport.centerY);
		forceOf<ForceManyBody<InternalNode>>(simulation, "charge")?.distanceMax(
			viewport.chargeDistanceMax,
		);
		forceOf<MstRepulsionForce<InternalNode>>(
			simulation,
			"mstRepulsion",
		)?.setMaxDistance(viewport.mstRepulsionMaxDistance);
		const linkParams = applied.params.link;
		forceOf<ForceLink<InternalNode, SimulationLink>>(
			simulation,
			"link",
		)?.distance((link) =>
			mstLinkDistance(link.distance, linkParams, viewport.k),
		);

		applied.width = dimensions.width;
		applied.height = dimensions.height;
		// A new panel size may need a larger zoom as well as a smaller one
		armAutoFit(autoFitRef.current);
		simulation.alpha(Math.max(simulation.alpha(), 0.1)).restart();
	}, [dimensions]);

	// Node sizes: collision radii in place, without restarting the layout
	useEffect(() => {
		const simulation = simulationRef.current;
		const applied = appliedRef.current;
		if (
			!simulation ||
			!applied ||
			applied.radiusSignature === radiusSignature
		) {
			return;
		}

		forceOf<ForceCollide<InternalNode>>(simulation, "collision")?.radius(
			(d) => radiusOfRef.current((d as InternalNode).id) * COLLISION_SCALE,
		);
		applied.radiusSignature = radiusSignature;
	}, [radiusSignature]);

	// DOM updates with the enter/update/exit pattern
	useEffect(() => {
		const g = gRef.current;
		if (!g) return;

		const linkSelection = g
			.select(".links-group")
			.selectAll<SVGLineElement, SimulationLink>("line")
			.data(
				simulationLinks,
				(d) => `${endpointKey(d.source)}-${endpointKey(d.target)}`,
			)
			.join(
				(enter) => enter.append("line").attr("stroke-opacity", 0.6),
				(update) => update,
				(exit) => exit.remove(),
			)
			.style("stroke", edgeColor)
			.attr("stroke-width", (d) => 1 + (1 - d.distance) * 2);

		// Relationship overlays inside what the tree leaves of the budget
		const relationSelection = joinRelationLines(
			g.select<SVGGElement>(".relations-group"),
			edgeSelection.relations,
			darkMode,
		);

		// Radius scale by selection state. Hover highlights are an outline, not a scale change.
		const scaleFor = (id: string): number => {
			if (id === selectedId) return 2.0;
			if (recentNodeIdsSet.has(id)) return 1.25;
			return 1.0;
		};

		// Hover outline fades with distance from the hovered node.
		const outlineFor = (
			id: string,
		): { stroke: string; strokeWidth: number } => {
			if (combinedHighlightedNodeIds.has(id)) {
				const distance = combinedHighlightedNodesDistance.get(id) ?? 1.0;
				const strokeWidth = Math.max(1.5, 3 - distance * 1.5);
				return { stroke: MAP_HIGHLIGHT, strokeWidth };
			}
			const base = styleOf(id);
			return { stroke: base.stroke, strokeWidth: base.strokeWidth };
		};

		const circleSelection = g
			.select<SVGGElement>(".circle-nodes")
			.selectAll<SVGCircleElement, InternalNode>("circle.node")
			.data(simulationNodes, (d) => d.id)
			.join(
				(enter) => {
					const circles = enter
						.append("circle")
						.attr("class", "node")
						.attr("cursor", "pointer");
					circles.append("title");
					circles
						.call(createDrag(simulationRef, 0.02))
						.on("click", (event: MouseEvent, d) => {
							event.stopPropagation();
							onNodeClickRef.current?.(d.id);
						})
						.on("mouseenter", (_event: MouseEvent, d) => {
							const graphNode = nodeByIdRef.current.get(d.id);
							if (graphNode) onNodeHoverRef.current?.(graphNode);
							if (highlightModeRef.current === "downstream") {
								setHoveredNodeId(d.id);
							}
						})
						.on("mouseleave", () => {
							onNodeHoverRef.current?.(null);
							if (highlightModeRef.current === "downstream") {
								setHoveredNodeId(null);
							}
						});
					return circles;
				},
				(update) => update,
				(exit) => exit.remove(),
			);

		// One shadow for the whole node group, not one per circle: a filter on
		// every circle made the browser re-rasterise hundreds of layers each
		// tick (19 fps at 200 nodes in light mode, 77 without shadows). The
		// shadow depends only on dark mode, so any node's style carries it.
		g.select<SVGGElement>(".circle-nodes").attr(
			"filter",
			simulationNodes.length ? styleOf(simulationNodes[0].id).filter : "none",
		);
		circleSelection
			.attr("fill", (d) => styleOf(d.id).fill)
			.attr("stroke", (d) => outlineFor(d.id).stroke)
			.attr("stroke-width", (d) => outlineFor(d.id).strokeWidth)
			.attr("r", (d) => radiusOf(d.id) * scaleFor(d.id))
			.attr("opacity", (d) => (styleOf(d.id).pulse ? 0.9 : 1))
			.select("title")
			.text((d) => nodeById.get(d.id)?.label || d.id);

		linkSelectionRef.current = linkSelection;
		relationSelectionRef.current = relationSelection;
		circleSelectionRef.current = circleSelection;
		pulseSelectionRef.current = circleSelection.filter(
			(d) => styleOf(d.id).pulse,
		);
		startPulse();
		// Place entered elements at once instead of waiting for the next tick
		drawPositions(
			linkSelection,
			relationSelection,
			circleSelection,
			simulationNodeById,
		);

		const overlay = overlayRef.current;
		if (!overlay) return;

		// Cursor ring (radius mode only) in screen coordinates: 50 px at any zoom
		const cursorCircleData =
			highlightMode === "radius" && cursorPosition ? [cursorPosition] : [];
		overlay
			.selectAll(".cursor-overlay")
			.data(cursorCircleData)
			.join("circle")
			.attr("class", "cursor-overlay")
			.attr("fill", "none")
			.attr("stroke", MAP_HIGHLIGHT)
			.attr("stroke-width", 2)
			.attr("stroke-dasharray", "5,5")
			.attr("pointer-events", "none")
			.attr("cx", (d) => d.x)
			.attr("cy", (d) => d.y)
			.attr("r", 50);

		// Timer arc around the cursor (radius mode only), at screen size like the ring
		const timerArcData =
			highlightMode === "radius" && timerActive && cursorPosition
				? [cursorPosition]
				: [];
		const arcGenerator = d3
			.arc()
			.innerRadius(48)
			.outerRadius(52)
			.startAngle(0)
			.endAngle(timerProgress * 2 * Math.PI);

		overlay
			.selectAll(".timer-arc")
			.data(timerArcData)
			.join("path")
			.attr("class", "timer-arc")
			.attr("fill", MAP_HIGHLIGHT)
			.attr("pointer-events", "none")
			.attr("transform", (d) => `translate(${d.x},${d.y})`)
			.attr("d", arcGenerator);
	}, [
		simulationNodes,
		simulationNodeById,
		simulationLinks,
		edgeSelection,
		darkMode,
		selectedId,
		radiusOf,
		nodeById,
		styleOf,
		edgeColor,
		recentNodeIdsSet,
		combinedHighlightedNodeIds,
		combinedHighlightedNodesDistance,
		cursorPosition,
		timerActive,
		timerProgress,
		highlightMode,
		startPulse,
	]);

	return (
		<div ref={containerRef} className={`relative h-full w-full ${className}`}>
			<svg
				ref={svgRef}
				width={dimensions.width}
				height={dimensions.height}
				style={{ backgroundColor }}
				className="h-full w-full"
				role="img"
				aria-label={t`Argument map`}
			/>

			<MapChromeButton
				label={t`Force Graph Settings`}
				onClick={() => setShowSettings(!showSettings)}
				className="right-4"
			>
				<GearIcon size={24} />
			</MapChromeButton>

			{showSettings && (
				<MapSettingsPanel
					title={<Trans>Force Parameters</Trans>}
					onReset={resetToDefaults}
				>
					<RangeSetting
						label={
							<Trans>
								Minimum link length: {linkDistanceConstant.toFixed(1)}
							</Trans>
						}
						min={0}
						max={50}
						step={0.5}
						value={linkDistanceConstant}
						onChange={(value) =>
							setLinkDistanceConstant(Number.parseFloat(value))
						}
					/>
					<RangeSetting
						label={
							<Trans>Medium distances: {linkDistanceLinear.toFixed(2)}</Trans>
						}
						min={0}
						max={10}
						step={0.1}
						value={linkDistanceLinear}
						onChange={(value) =>
							setLinkDistanceLinear(Number.parseFloat(value))
						}
					/>
					<RangeSetting
						label={
							<Trans>
								Dissimilar links: {linkDistanceQuadratic.toFixed(2)}
							</Trans>
						}
						min={0}
						max={10}
						step={0.1}
						value={linkDistanceQuadratic}
						onChange={(value) =>
							setLinkDistanceQuadratic(Number.parseFloat(value))
						}
					/>
					<RangeSetting
						label={
							<Trans>
								General repulsion force: {chargeStrength.toFixed(1)}
							</Trans>
						}
						min={-100}
						max={0}
						step={0.5}
						value={chargeStrength}
						onChange={(value) => setChargeStrength(Number.parseFloat(value))}
					/>
					<RangeSetting
						label={
							<Trans>
								Tree repulsion factor: {mstRepulsionCoeff.toFixed(3)}
							</Trans>
						}
						min={0}
						max={0.5}
						step={0.001}
						value={mstRepulsionCoeff}
						onChange={(value) => setMstRepulsionCoeff(Number.parseFloat(value))}
					/>
				</MapSettingsPanel>
			)}
		</div>
	);
};

/** Drag pins a node while held and releases it on drop. */
function createDrag(
	simulationRef: { current: Simulation<InternalNode> | null },
	endAlphaTarget: number,
) {
	return d3
		.drag<SVGCircleElement, InternalNode>()
		.on("start", (event, d) => {
			if (!event.active) simulationRef.current?.alphaTarget(0.3).restart();
			d.fx = d.x;
			d.fy = d.y;
		})
		.on("drag", (event, d) => {
			d.fx = event.x;
			d.fy = event.y;
		})
		.on("end", (event, d) => {
			if (!event.active) simulationRef.current?.alphaTarget(endAlphaTarget);
			d.fx = null;
			d.fy = null;
		});
}

export interface MstMapProps extends Omit<MstGraphProps, "recentNodeIds"> {
	/**
	 * Called with the selected node and when the walk will move on: for the
	 * random pick on load, a click, each walk step, and when the walk starts
	 * (autoAdvance switched on). Selection changes made elsewhere (the
	 * LocalMap, the page) restart the walk interval without a call here.
	 */
	onActiveNodeChange?: (
		node: MapGraphNode | null,
		expiresAt: number | null,
		durationMs: number,
	) => void;
	walkIntervalMs?: number;
	/** Walk to a random tree neighbour every walkIntervalMs. Off: no timer runs. */
	autoAdvance?: boolean;
}

type WalkState = {
	/** A walk timer is running. */
	active: boolean;
	/** When the walk moves on. */
	expiresAt: number | null;
	/** The selection revision the walk last saw. */
	observedRevision: number | null;
	/** A selection this wrapper just made, with the expiry it reported. */
	pendingOwn: { id: string; expiresAt: number } | null;
};

/**
 * MST map with selection in the interaction store: picks a random node on
 * load, scales the ten most recent nodes, and walks to a random tree
 * neighbour every walk interval while autoAdvance is on. The walk follows
 * tree edges only, never relationship overlays.
 */
export const MstMap = memo(function MstMap({
	nodes,
	onActiveNodeChange,
	walkIntervalMs = DEFAULT_WALK_INTERVAL_MS,
	autoAdvance = true,
	mstEdges: providedMstEdges,
	...graphProps
}: MstMapProps) {
	const {
		onNodeClick: externalOnNodeClick,
		selectedId: _selectedId,
		...restGraphProps
	} = graphProps;

	const recentNodeIds = useMemo(() => newestNodeIds(nodes), [nodes]);
	const nodeById = useMemo(
		() => new Map(nodes.map((node) => [node.id, node])),
		[nodes],
	);

	// Built once per node set (or taken from the layout result) and handed to the graph
	const geometry = useRendererGeometry(
		nodes,
		{ mstEdges: providedMstEdges },
		buildOwnGeometry,
	);
	const adjacency = useMemo(
		() => adjacencyOf(geometry.nodes, geometry.mstEdges),
		[geometry.nodes, geometry.mstEdges],
	);

	const sharedSelectedNodeId = useMapInteraction(
		(state) => state.selectedNodeId,
	);
	const setSharedSelectedNodeId = useMapInteraction(
		(state) => state.setSelectedNodeId,
	);
	// Bumped by every selection, also of the selected node again
	const selectionRevision = useMapInteraction(
		(state) => state.selectionRevision,
	);

	const onActiveNodeChangeRef = useRef(onActiveNodeChange);
	onActiveNodeChangeRef.current = onActiveNodeChange;

	const walkRef = useRef<WalkState>({
		active: false,
		expiresAt: null,
		observedRevision: null,
		pendingOwn: null,
	});

	const selectNode = useCallback(
		(nodeId: string) => {
			const node = nodeById.get(nodeId);
			if (!node) return;

			const expiresAt = Date.now() + walkIntervalMs;
			walkRef.current.pendingOwn = { expiresAt, id: nodeId };
			setSharedSelectedNodeId(nodeId);
			onActiveNodeChangeRef.current?.(node, expiresAt, walkIntervalMs);
		},
		[nodeById, walkIntervalMs, setSharedSelectedNodeId],
	);

	const pickRandomNeighbor = useCallback(
		(nodeId: string) => {
			const neighbors = Array.from(adjacency.get(nodeId) ?? []);
			if (neighbors.length) {
				return neighbors[Math.floor(Math.random() * neighbors.length)];
			}

			const fallback = nodes.filter((node) => node.id !== nodeId);
			if (!fallback.length) {
				return nodeId;
			}

			return fallback[Math.floor(Math.random() * fallback.length)].id;
		},
		[adjacency, nodes],
	);

	const handleNodeClick = useCallback(
		(nodeId: string) => {
			selectNode(nodeId);
			externalOnNodeClick?.(nodeId);
		},
		[externalOnNodeClick, selectNode],
	);

	// Random selection on load, and whenever the selected node disappears
	useEffect(() => {
		if (!nodes.length) {
			if (sharedSelectedNodeId !== null) {
				setSharedSelectedNodeId(null);
				onActiveNodeChangeRef.current?.(null, null, walkIntervalMs);
			}
			return;
		}

		if (sharedSelectedNodeId && nodeById.has(sharedSelectedNodeId)) {
			return;
		}

		selectNode(nodes[Math.floor(Math.random() * nodes.length)].id);
	}, [
		nodes,
		nodeById,
		sharedSelectedNodeId,
		selectNode,
		setSharedSelectedNodeId,
		walkIntervalMs,
	]);

	// Random walk. The next step is due walkIntervalMs after the latest
	// selection, wherever it came from, a selection of the selected node too.
	useEffect(() => {
		const walk = walkRef.current;
		const own =
			walk.pendingOwn && walk.pendingOwn.id === sharedSelectedNodeId
				? walk.pendingOwn
				: null;
		if (own) walk.pendingOwn = null;
		const selectionChanged = walk.observedRevision !== selectionRevision;
		walk.observedRevision = selectionRevision;

		const selectedNode = sharedSelectedNodeId
			? nodeById.get(sharedSelectedNodeId)
			: undefined;
		if (!autoAdvance || !sharedSelectedNodeId || !selectedNode) {
			walk.active = false;
			walk.expiresAt = null;
			return;
		}

		const now = Date.now();
		if (own) {
			// Selected here (load, click, walk step); the expiry was already reported
			walk.expiresAt = own.expiresAt;
		} else if (!walk.active || walk.expiresAt === null) {
			// The walk starts on an existing selection
			walk.expiresAt = now + walkIntervalMs;
			onActiveNodeChangeRef.current?.(
				selectedNode,
				walk.expiresAt,
				walkIntervalMs,
			);
		} else if (selectionChanged) {
			// Selected elsewhere (the LocalMap, the page): restart the interval
			walk.expiresAt = now + walkIntervalMs;
		}
		walk.active = true;

		const timeoutId = setTimeout(
			() => {
				selectNode(pickRandomNeighbor(sharedSelectedNodeId));
			},
			Math.max(0, walk.expiresAt - now),
		);

		return () => clearTimeout(timeoutId);
	}, [
		autoAdvance,
		nodeById,
		pickRandomNeighbor,
		selectNode,
		selectionRevision,
		sharedSelectedNodeId,
		walkIntervalMs,
	]);

	return (
		<div className="relative h-full w-full">
			<MstGraph
				nodes={nodes}
				selectedId={sharedSelectedNodeId ?? undefined}
				onNodeClick={handleNodeClick}
				recentNodeIds={recentNodeIds}
				highlightMode="downstream"
				{...restGraphProps}
				mstEdges={geometry.mstEdges}
			/>
		</div>
	);
});
