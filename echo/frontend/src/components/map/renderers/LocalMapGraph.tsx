import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { GearIcon, PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	createFurtherPairForce,
	createNearestNeighbourForce,
	LOCAL_MAP_FORCE_DEFAULTS,
	type LocalMapForceParams,
	type NearestNeighbourForce,
	type PairForce,
} from "../graph/forces";
import { calculateInitialPositions } from "../graph/layout";
import {
	buildLocalMapForces,
	LOCAL_MAP_SEED,
	type LocalMapLink,
	type LocalMapNeighbours,
	seededRandom,
} from "../graph/localMap";
import { buildMST, cosineDistanceGuarded } from "../graph/mst";
import { newestNodeIds } from "../graph/nodeSet";
import { MAP_NEIGHBOUR_LINK_RED, mapHighlight } from "../graph/nodeStyle";
import { type EdgeCounts, selectLocalMapEdges } from "../layout/edgeBudget";
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
	type ForceManyBody,
	type Selection,
	type Simulation,
	type SimulationNodeDatum,
	type ZoomBehavior,
	type ZoomTransform,
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
import {
	MapChromeButton,
	MapSettingsPanel,
	MapSettingsSection,
	RangeSetting,
} from "./MapChrome";
import { DEFAULT_WALK_INTERVAL_MS } from "./MstGraph";
import {
	drawRelationPositions,
	joinRelationLines,
	type RelationLineSelection,
} from "./relations";

/**
 * LocalMap graph: a force-directed implementation of LocalMAP. Runs k-NN and
 * further pairs (from the layout result, or computed here) as custom d3
 * forces. The simulation is created once and updated in place.
 */

interface InternalNode extends SimulationNodeDatum {
	id: string;
}

type LineSelection = Selection<SVGLineElement, LocalMapLink, BaseType, unknown>;
type CircleSelection = Selection<
	SVGCircleElement,
	InternalNode,
	SVGGElement,
	unknown
>;
type CountSelection = Selection<
	SVGTextElement,
	InternalNode,
	SVGGElement,
	unknown
>;

export interface LocalMapGraphProps {
	nodes: MapGraphNode[];
	colorBy?: ColorBy;
	darkMode?: boolean;
	selectedId?: string | null;
	onNodeClick?: (nodeId: string) => void;
	onNodeHover?: (node: MapGraphNode | null) => void;
	timerActive?: boolean;
	timerProgress?: number;
	className?: string;
	/** Base node radius; each node's size scale multiplies it. */
	nodeRadius?: number;
	backgroundColor?: string;
	recentNodeIds?: string[];
	/**
	 * Draw nearest-neighbour links, a deterministic subset within the edge
	 * budget. Off in Map (Jorim, September 15th 2026): the neighbour forces
	 * still shape the layout, drawn or not.
	 */
	showNeighbourLinks?: boolean;
	/**
	 * Neighbour and further pairs from useMapGeometry. Without them the graph
	 * computes its own.
	 */
	neighbours?: LocalMapNeighbours;
	/** Tree edges for the initial layout, from the same result. */
	mstEdges?: Edge[];
	/**
	 * Explicit relationships between nodes (revision ids). Drawn as dashed
	 * overlays; they never enter the neighbour forces.
	 */
	relations?: MapRelation[];
	/** Visible-edge budget, shared by relationship and neighbour lines. */
	edgeLimit: number;
	/** Draw every relationship within the budget, not only the selected node's. */
	showRelationships?: boolean;
	/** Drawn and available connection counts, called when they change. */
	onEdgeCounts?: (counts: EdgeCounts) => void;
}

/** The forces the running simulation was last configured with. */
type AppliedForces = {
	width: number;
	height: number;
	params: LocalMapForceParams;
	/** Node radii the collision force was initialised with. */
	radiusSignature: string;
};

const EMPTY_LINKS: LocalMapLink[] = [];
const EMPTY_RELATIONS: MapRelation[] = [];

/**
 * The synchronous path: tree and neighbour pairs computed here when no
 * layout result is given, with the same versioned seed as the worker.
 */
const buildOwnGeometry = (
	nodes: ReadonlyArray<MapGraphNode>,
): GeometryBuild => {
	if (!nodes.length) {
		return { mstEdges: [], neighbours: { fpLinks: [], nnLinks: [] } };
	}
	const { nnLinks, fpLinks } = buildLocalMapForces(
		nodes,
		0.2,
		2.0,
		seededRandom(LOCAL_MAP_SEED),
	);
	return {
		mstEdges: buildMST(nodes, cosineDistanceGuarded),
		neighbours: { fpLinks, nnLinks },
	};
};

const forceOf = <F,>(
	simulation: Simulation<InternalNode>,
	name: string,
): F | undefined => simulation.force(name) as F | undefined;

/** Link endpoints are ids (no d3.forceLink resolves them); look the nodes up. */
const drawPositions = (
	lines: LineSelection | null,
	relationLines: RelationLineSelection | null,
	circles: CircleSelection | null,
	counts: CountSelection | null,
	nodeById: Map<string, InternalNode>,
) => {
	lines
		?.attr("x1", (d) => nodeById.get(d.source)?.x ?? null)
		.attr("y1", (d) => nodeById.get(d.source)?.y ?? null)
		.attr("x2", (d) => nodeById.get(d.target)?.x ?? null)
		.attr("y2", (d) => nodeById.get(d.target)?.y ?? null);
	drawRelationPositions(relationLines, nodeById);
	circles?.attr("cx", (d) => d.x ?? 0).attr("cy", (d) => d.y ?? 0);
	counts?.attr("x", (d) => d.x ?? 0).attr("y", (d) => d.y ?? 0);
};

export const LocalMapGraph = ({
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
	showNeighbourLinks = false,
	backgroundColor = "transparent",
	recentNodeIds = EMPTY_NODE_IDS,
	neighbours: providedNeighbours,
	mstEdges: providedMstEdges,
	relations = EMPTY_RELATIONS,
	edgeLimit,
	showRelationships = false,
	onEdgeCounts,
}: LocalMapGraphProps) => {
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
	const savedTransformRef = useRef<ZoomTransform | null>(null);
	const autoFitRef = useRef(createAutoFitState());
	const positionCacheRef = useRef<
		Map<string, { x: number; y: number; vx: number; vy: number }>
	>(new Map());
	const lineSelectionRef = useRef<LineSelection | null>(null);
	const relationSelectionRef = useRef<RelationLineSelection | null>(null);
	const circleSelectionRef = useRef<CircleSelection | null>(null);
	const countSelectionRef = useRef<CountSelection | null>(null);
	const pulseSelectionRef = useRef<CircleSelection | null>(null);
	const startPulse = usePulseTimer(pulseSelectionRef);
	const linkOpacityRef = useRef<(link: LocalMapLink) => number>(() => 0.3);
	const nnForceRef = useRef<NearestNeighbourForce<InternalNode> | null>(null);
	const fpForceRef = useRef<PairForce<InternalNode> | null>(null);
	const appliedRef = useRef<AppliedForces | null>(null);

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

	const [cursorPosition, setCursorPosition] = useState<{
		x: number;
		y: number;
	} | null>(null);
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
	const [paused, setPaused] = useState(false);
	const pausedRef = useRef(false);
	useEffect(() => {
		if (pausedRef.current === paused) return;
		pausedRef.current = paused;
		const sim = simulationRef.current;
		if (!sim) return;
		if (paused) sim.stop();
		else sim.alpha(0.3).restart();
	}, [paused]);
	const [cMed, setCMed] = useState(LOCAL_MAP_FORCE_DEFAULTS.cMed);
	const [dAdj, setDAdj] = useState(LOCAL_MAP_FORCE_DEFAULTS.dAdj);
	const [nnStrength, setNnStrength] = useState(
		LOCAL_MAP_FORCE_DEFAULTS.nnStrength,
	);
	const [fpStrength, setFpStrength] = useState(
		LOCAL_MAP_FORCE_DEFAULTS.fpStrength,
	);
	// Negative = repulsion; shown as abs in the UI
	const [chargeStrength, setChargeStrength] = useState(
		LOCAL_MAP_FORCE_DEFAULTS.chargeStrength,
	);
	const [collisionRadius, setCollisionRadius] = useState(
		LOCAL_MAP_FORCE_DEFAULTS.collisionRadius,
	);
	const [chargeFraction, setChargeFraction] = useState(
		LOCAL_MAP_FORCE_DEFAULTS.chargeFraction,
	);

	const params = useMemo<LocalMapForceParams>(
		() => ({
			chargeFraction,
			chargeStrength,
			cMed,
			collisionRadius,
			dAdj,
			fpStrength,
			nnStrength,
		}),
		[
			cMed,
			chargeFraction,
			chargeStrength,
			collisionRadius,
			dAdj,
			fpStrength,
			nnStrength,
		],
	);
	const paramsRef = useRef(params);
	paramsRef.current = params;

	const resetToDefaults = useCallback(() => {
		setCMed(LOCAL_MAP_FORCE_DEFAULTS.cMed);
		setDAdj(LOCAL_MAP_FORCE_DEFAULTS.dAdj);
		setNnStrength(LOCAL_MAP_FORCE_DEFAULTS.nnStrength);
		setFpStrength(LOCAL_MAP_FORCE_DEFAULTS.fpStrength);
		setChargeStrength(LOCAL_MAP_FORCE_DEFAULTS.chargeStrength);
		setCollisionRadius(LOCAL_MAP_FORCE_DEFAULTS.collisionRadius);
		setChargeFraction(LOCAL_MAP_FORCE_DEFAULTS.chargeFraction);
	}, []);

	// Geometry, once per node set (ids and vectors): the layout result when
	// given and matching these nodes, otherwise the last one that did
	const geometry = useRendererGeometry(
		nodes,
		{ mstEdges: providedMstEdges, neighbours: providedNeighbours },
		buildOwnGeometry,
	);
	const geometryNodes = geometry.nodes;
	const mstEdges = geometry.mstEdges;
	const centerId = geometry.centerId;
	const nnLinks = geometry.neighbours?.nnLinks ?? EMPTY_LINKS;
	const fpLinks = geometry.neighbours?.fpLinks ?? EMPTY_LINKS;
	// Clear this panel's hover highlight when its nodes leave or the map unmounts
	useReleaseOwnedHighlight("local-hover", geometryNodes);

	// Initial positions from the MST structure at a fixed viewport size
	const initialPositions = useMemo(
		() =>
			calculateInitialPositions(geometryNodes, mstEdges, 800, 600, centerId),
		[geometryNodes, mstEdges, centerId],
	);

	// Defensive copy of nodes to prevent D3 mutations from affecting React state.
	// Seeds positions from the position cache, or initialPositions on first render.
	const simulationNodes = useMemo(() => {
		// First NN neighbour per node, for placing new nodes
		const nnNeighborMap = new Map<string, string>();
		for (const link of nnLinks) {
			if (!nnNeighborMap.has(link.source)) {
				nnNeighborMap.set(link.source, link.target);
			}
			if (!nnNeighborMap.has(link.target)) {
				nnNeighborMap.set(link.target, link.source);
			}
		}

		const cache = positionCacheRef.current;
		const jitter = () => (Math.random() - 0.5) * 30;

		return geometryNodes.map((node): InternalNode => {
			const cached = cache.get(node.id);
			if (cached) {
				return { id: node.id, ...cached };
			}

			// New node: near its nearest neighbour with a small random offset
			const neighborId = nnNeighborMap.get(node.id);
			const neighborPos = neighborId ? cache.get(neighborId) : null;
			if (neighborPos) {
				return {
					id: node.id,
					vx: 0,
					vy: 0,
					x: neighborPos.x + jitter(),
					y: neighborPos.y + jitter(),
				};
			}

			// First node or no neighbour info: initial layout position
			const initial = initialPositions.get(node.id);
			return {
				id: node.id,
				vx: 0,
				vy: 0,
				x: initial?.x ?? sizeRef.current.width / 2 + jitter(),
				y: initial?.y ?? sizeRef.current.height / 2 + jitter(),
			};
		});
	}, [geometryNodes, nnLinks, initialPositions, sizeRef]);

	const simulationNodeById = useMemo(
		() => new Map(simulationNodes.map((node) => [node.id, node])),
		[simulationNodes],
	);
	const simulationNodeByIdRef = useRef(simulationNodeById);
	simulationNodeByIdRef.current = simulationNodeById;

	// Lines inside the visible-edge budget. Which lines are drawn never
	// changes the neighbour forces: those always get every pair.
	const placedNodeIds = useMemo(
		() => new Set(geometryNodes.map((node) => node.id)),
		[geometryNodes],
	);
	const edgeSelection = useMemo(
		() =>
			selectLocalMapEdges({
				edgeLimit,
				neighbourLinks: nnLinks,
				nodeIds: placedNodeIds,
				relations,
				selectedId,
				showNeighbourLinks,
				showRelationships,
			}),
		[
			edgeLimit,
			nnLinks,
			placedNodeIds,
			relations,
			selectedId,
			showNeighbourLinks,
			showRelationships,
		],
	);
	useReportEdgeCounts(edgeSelection.counts, onEdgeCounts);

	// Prune stale cache entries when nodes change
	useEffect(() => {
		const currentIds = new Set(geometryNodes.map((n) => n.id));
		const cache = positionCacheRef.current;
		for (const id of cache.keys()) {
			if (!currentIds.has(id)) {
				cache.delete(id);
			}
		}
	}, [geometryNodes]);

	// Cursor tracking: immediate visual feedback, preview highlight published
	// at once, settled highlight after 500 ms without movement
	useEffect(() => {
		if (!svgRef.current) return;

		const svg = svgRef.current;
		const HIGHLIGHT_RADIUS = 50;
		let rafId: number | null = null;
		let lastProcessedTime = 0;
		const THROTTLE_MS = 50; // Throttle calculations to 20fps max

		const processMouseMove = (x: number, y: number) => {
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
						Math.max(0, radiusOfRef.current(node.id) - nodeRadiusRef.current) *
						transform.k;
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

			// Publish the preview highlight immediately so the MST map sees the hover
			setHighlightedNodeIds(highlighted, {
				isPreview: true,
				source: "local-hover",
			});
			setHighlightedNodesDistance(distances);

			// Publish a settled highlight (lets the timer run) after 0.5s without movement
			mouseMoveTimeoutRef.current = window.setTimeout(() => {
				setHighlightedNodeIds(highlighted, {
					isPreview: false,
					source: "local-hover",
				});
				setHighlightedNodesDistance(distances);
			}, 500);
		};

		const handleMouseMove = (event: MouseEvent) => {
			const rect = svg.getBoundingClientRect();
			const x = event.clientX - rect.left;
			const y = event.clientY - rect.top;

			const now = Date.now();
			const timeSinceLastProcess = now - lastProcessedTime;

			if (timeSinceLastProcess >= THROTTLE_MS) {
				lastProcessedTime = now;
				processMouseMove(x, y);
			} else {
				if (rafId !== null) {
					cancelAnimationFrame(rafId);
				}
				rafId = requestAnimationFrame(() => {
					lastProcessedTime = Date.now();
					processMouseMove(x, y);
					rafId = null;
				});
			}
		};

		const handleMouseLeave = () => {
			if (mouseMoveTimeoutRef.current !== null) {
				window.clearTimeout(mouseMoveTimeoutRef.current);
				mouseMoveTimeoutRef.current = null;
			}
			// A queued move would publish the hover again after the pointer left
			if (rafId !== null) {
				cancelAnimationFrame(rafId);
				rafId = null;
			}

			setCursorPosition(null);
			setLocalHighlightedNodeIds(new Set());
			setLocalHighlightedNodesDistance(new Map());
			// Only clear the store if this panel's hover set the highlight.
			// History-driven selections persist until the user toggles them off.
			const currentSource = interactionStore.getState().highlightSource;
			if (currentSource === "local-hover") {
				setHighlightedNodeIds(new Set(), {
					isPreview: false,
					source: "local-hover",
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
			if (rafId !== null) {
				cancelAnimationFrame(rafId);
			}
			svg.removeEventListener("mousemove", handleMouseMove);
			svg.removeEventListener("mouseleave", handleMouseLeave);
		};
	}, [setHighlightedNodeIds, setHighlightedNodesDistance, interactionStore]);

	// One-time SVG and zoom setup
	useEffect(() => {
		const svgElement = svgRef.current;
		if (!svgElement || gRef.current) return;

		const svg = d3.select(svgElement);

		const g = svg.append("g");
		gRef.current = g;

		g.append("g").attr("class", "nn-links-group");
		g.append("g").attr("class", "relations-group");
		g.append("g")
			.attr("class", "nodes-group")
			.append("g")
			.attr("class", "circle-nodes");
		g.append("g").attr("class", "merge-counts").attr("pointer-events", "none");
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
				savedTransformRef.current = event.transform;
				// A wheel or pan by the user: stop fitting until the node set changes
				if (event.sourceEvent) autoFitRef.current.userZoomed = true;
			});

		svg.call(zoom);
		zoomRef.current = zoom;

		if (savedTransformRef.current) {
			svg.call(zoom.transform, savedTransformRef.current);
		}

		return () => {
			cancelAutoFit(svgElement, autoFitRef.current);
			svg.on(".zoom", null);
			zoomRef.current = null;
			gRef.current = null;
			overlayRef.current = null;
			lineSelectionRef.current = null;
			relationSelectionRef.current = null;
			circleSelectionRef.current = null;
			countSelectionRef.current = null;
			pulseSelectionRef.current = null;
			svg.selectAll("*").remove();
		};
	}, [sizeRef]);

	// Clean up simulation on unmount
	useEffect(() => {
		return () => {
			simulationRef.current?.stop().on("tick", null);
			simulationRef.current = null;
			nnForceRef.current = null;
			fpForceRef.current = null;
			appliedRef.current = null;
		};
	}, []);

	// Simulation lifecycle: create once, update incrementally
	useEffect(() => {
		if (!gRef.current) return;
		const existing = simulationRef.current;

		if (simulationNodes.length === 0) {
			// Let go of the simulation, so a resize or a slider change cannot
			// restart it; the next nodes create a new one
			if (existing) {
				existing.stop().on("tick", null);
				simulationRef.current = null;
				nnForceRef.current = null;
				fpForceRef.current = null;
				appliedRef.current = null;
			}
			return;
		}

		if (existing) {
			// Incremental update: swap nodes and links, keep the simulation alive
			const oldNodeMap = new Map(existing.nodes().map((n) => [n.id, n]));
			for (const node of simulationNodes) {
				const old = oldNodeMap.get(node.id);
				if (old && old !== node) {
					node.x = old.x;
					node.y = old.y;
					node.vx = (old.vx ?? 0) * 0.5;
					node.vy = (old.vy ?? 0) * 0.5;
				}
				// New nodes already have positions from the cache or initialPositions
			}

			existing.nodes(simulationNodes);
			nnForceRef.current?.setLinks(nnLinks);
			fpForceRef.current?.setLinks(fpLinks);
			// A new node set is fitted afresh, in either direction while it settles
			cancelAutoFit(svgRef.current, autoFitRef.current);
			armAutoFit(autoFitRef.current, { resetUserZoom: true });

			// Gentle restart; low alpha avoids disrupting settled nodes
			if (!pausedRef.current) {
				existing.alpha(Math.max(existing.alpha(), 0.3)).restart();
			}
			return;
		}

		// First time: create the simulation with forces at the measured size
		const size = measure();
		const current = paramsRef.current;

		const nnForce = createNearestNeighbourForce<InternalNode>(
			nnLinks,
			current.cMed,
			current.dAdj,
		).setStrength(current.nnStrength);
		const fpForce = createFurtherPairForce<InternalNode>(fpLinks).setStrength(
			current.fpStrength,
		);
		nnForceRef.current = nnForce;
		fpForceRef.current = fpForce;

		const simulation = d3
			.forceSimulation<InternalNode>(simulationNodes)
			.force("nnForce", nnForce)
			.force("fpRepulsion", fpForce)
			.force(
				"charge",
				d3
					.forceManyBody<InternalNode>()
					.strength(current.chargeStrength)
					.distanceMax(
						Math.min(size.width, size.height) * current.chargeFraction,
					),
			)
			.force(
				"center",
				d3
					.forceCenter<InternalNode>(size.width / 2, size.height / 2)
					.strength(0.1),
			)
			.force(
				"collision",
				d3
					.forceCollide<InternalNode>()
					.radius(
						(d) =>
							radiusOfRef.current(d.id) * paramsRef.current.collisionRadius,
					)
					.strength(1.0),
			)
			.alpha(0.8)
			.alphaDecay(0.004)
			.alphaTarget(0.005);

		let lastAlphaStep = -1;
		simulation.on("tick", () => {
			// Adaptive force strengths, updated only when alpha crosses a 0.05 step
			const alpha = simulation.alpha();
			const alphaStep = Math.floor(alpha * 20) / 20;

			if (alpha > 0.005 && alphaStep !== lastAlphaStep) {
				lastAlphaStep = alphaStep;
				const base = paramsRef.current;

				// Charge: stronger repulsion early, weaker late
				forceOf<ForceManyBody<InternalNode>>(simulation, "charge")?.strength(
					base.chargeStrength * (1 + (alpha / 0.8) * 2.5),
				);
				// NN attraction: stronger early to form clusters, weaker late
				nnForce.setStrength(base.nnStrength * (1 + (alpha / 0.8) * 1.5));
				// FP repulsion: stronger early to separate far nodes
				fpForce.setStrength(base.fpStrength * (1 + (alpha / 0.8) * 2));
			}

			drawPositions(
				lineSelectionRef.current,
				relationSelectionRef.current,
				circleSelectionRef.current,
				countSelectionRef.current,
				simulationNodeByIdRef.current,
			);

			// Persist positions across re-renders
			const cache = positionCacheRef.current;
			for (const node of simulation.nodes()) {
				cache.set(node.id, {
					vx: node.vx ?? 0,
					vy: node.vy ?? 0,
					x: node.x ?? 0,
					y: node.y ?? 0,
				});
			}

			// Keep the map inside its panel
			const fitState = autoFitRef.current;
			fitState.tick++;
			if (fitState.tick % AUTO_FIT_EVERY_TICKS === 0) {
				autoFit({
					animate: true,
					nodes: simulation.nodes(),
					padding: (node) => radiusOfRef.current(node.id) * FIT_PADDING_SCALE,
					respectUserZoom: true,
					size: sizeRef.current,
					state: fitState,
					svgElement: svgRef.current,
					zoom: zoomRef.current,
				});
			}
		});

		if (pausedRef.current) simulation.stop();

		simulationRef.current = simulation;

		// Fit the first layout at once, not on a later tick: a paused map or a
		// background tab may not tick for a long while
		armAutoFit(autoFitRef.current, { resetUserZoom: true });
		autoFit({
			animate: false,
			nodes: simulationNodes,
			padding: (node) => radiusOfRef.current(node.id) * FIT_PADDING_SCALE,
			respectUserZoom: true,
			size,
			state: autoFitRef.current,
			svgElement: svgRef.current,
			zoom: zoomRef.current,
		});
		appliedRef.current = {
			height: size.height,
			params: current,
			radiusSignature: radiusSignatureRef.current,
			width: size.width,
		};
	}, [simulationNodes, nnLinks, fpLinks, measure, sizeRef]);

	// DOM updates with the enter/update/exit pattern
	useEffect(() => {
		const g = gRef.current;
		if (!g) return;

		// Hover outline, cursor ring and timer arc, in this theme's blue.
		const highlight = mapHighlight(darkMode);

		const touchesHighlight = (link: LocalMapLink) =>
			combinedHighlightedNodeIds.has(link.source) ||
			combinedHighlightedNodeIds.has(link.target);
		const opacityFor = (link: LocalMapLink) =>
			touchesHighlight(link) ? 0.6 : 0.3;
		// Either end highlighted: thickness by proximity of the closest end,
		// distance 0-1 maps to width 2.0-0.5
		const widthFor = (link: LocalMapLink) => {
			if (!touchesHighlight(link)) return 1;
			const minDistance = Math.min(
				combinedHighlightedNodesDistance.get(link.source) ?? 1.0,
				combinedHighlightedNodesDistance.get(link.target) ?? 1.0,
			);
			return 2.0 - minDistance * 1.5;
		};
		linkOpacityRef.current = opacityFor;

		// NN links, only with showNeighbourLinks and only within the budget:
		// emphasised near highlighted nodes, new lines fading in over 600 ms
		// towards their target opacity. Hidden, the join has no data and the
		// forces are unaffected.
		const lineSelection = g
			.select(".nn-links-group")
			.selectAll<SVGLineElement, LocalMapLink>("line")
			.data(edgeSelection.neighbours, (d) => `${d.source}-${d.target}`)
			.join(
				(enter) =>
					enter
						.append("line")
						.attr("stroke", MAP_NEIGHBOUR_LINK_RED)
						.attr("stroke-opacity", 0)
						.call((lines) => {
							lines
								.transition()
								.duration(600)
								.ease(d3.easeCubicOut)
								.attrTween(
									"stroke-opacity",
									(d) => (progress: number) =>
										String(linkOpacityRef.current(d) * progress),
								);
						}),
				(update) => update.attr("stroke-opacity", opacityFor),
				(exit) => exit.remove(),
			)
			.attr("stroke-width", widthFor);

		// Relationship overlays, sharing the budget with the neighbour lines
		const relationSelection = joinRelationLines(
			g.select<SVGGElement>(".relations-group"),
			edgeSelection.relations,
			darkMode,
		);

		// MN and FP links are invisible (only forces, no visual)

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
				return { stroke: highlight, strokeWidth };
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
						.call(createDrag(simulationRef, pausedRef))
						.on("click", (event: MouseEvent, d) => {
							event.stopPropagation();
							onNodeClickRef.current?.(d.id);
						})
						.on("mouseenter", (_event: MouseEvent, d) => {
							const graphNode = nodeByIdRef.current.get(d.id);
							if (graphNode) onNodeHoverRef.current?.(graphNode);
						})
						.on("mouseleave", () => {
							onNodeHoverRef.current?.(null);
						});
					return circles;
				},
				(update) => update,
				(exit) => exit.remove(),
			);

		// One shadow for the whole node group, not one per circle (see
		// MstGraph): per-circle filters dominated the frame at 200 nodes.
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

		const countSelection = g
			.select<SVGGElement>(".merge-counts")
			.selectAll<SVGTextElement, InternalNode>("text.merge-count")
			.data(
				simulationNodes.filter(
					(d) =>
						(nodeById.get(d.id)?.metadata.consolidation?.memberCount ?? 0) > 1,
				),
				(d) => d.id,
			)
			.join("text")
			.attr("class", "merge-count")
			.attr("role", "img")
			.attr("text-anchor", "middle")
			.attr("dominant-baseline", "central")
			.attr("font-size", 12)
			.attr("font-weight", 700)
			.attr("fill", "var(--map-surface, white)")
			.attr("stroke", "var(--map-text, black)")
			.attr("stroke-width", 0.75)
			.attr("stroke-linejoin", "round")
			.attr("paint-order", "stroke")
			.attr(
				"aria-label",
				(d) =>
					t`Combined from ${nodeById.get(d.id)?.metadata.consolidation?.memberCount ?? 0} arguments`,
			)
			.text(
				(d) => nodeById.get(d.id)?.metadata.consolidation?.memberCount ?? "",
			);

		lineSelectionRef.current = lineSelection;
		relationSelectionRef.current = relationSelection;
		circleSelectionRef.current = circleSelection;
		countSelectionRef.current = countSelection;
		pulseSelectionRef.current = circleSelection.filter(
			(d) => styleOf(d.id).pulse,
		);
		startPulse();
		// Place entered elements at once instead of waiting for the next tick
		drawPositions(
			lineSelection,
			relationSelection,
			circleSelection,
			countSelection,
			simulationNodeById,
		);

		const overlay = overlayRef.current;
		if (!overlay) return;

		// Cursor ring in screen coordinates: 50 px at any zoom
		const cursorCircleData = cursorPosition ? [cursorPosition] : [];
		overlay
			.selectAll(".cursor-overlay")
			.data(cursorCircleData)
			.join("circle")
			.attr("class", "cursor-overlay")
			.attr("fill", "none")
			.attr("stroke", highlight)
			.attr("stroke-width", 2)
			.attr("stroke-dasharray", "5,5")
			.attr("pointer-events", "none")
			.attr("cx", (d) => d.x)
			.attr("cy", (d) => d.y)
			.attr("r", 50);

		// Timer arc around the cursor, at screen size like the ring
		const timerArcData = timerActive && cursorPosition ? [cursorPosition] : [];
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
			.attr("fill", highlight)
			.attr("pointer-events", "none")
			.attr("transform", (d) => `translate(${d.x},${d.y})`)
			.attr("d", arcGenerator);
	}, [
		simulationNodes,
		simulationNodeById,
		edgeSelection,
		darkMode,
		selectedId,
		nodeById,
		radiusOf,
		styleOf,
		recentNodeIdsSet,
		combinedHighlightedNodeIds,
		combinedHighlightedNodesDistance,
		cursorPosition,
		timerActive,
		timerProgress,
		startPulse,
	]);

	// Resize: move the centre and the charge horizon in place
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

		forceOf<ForceCenter<InternalNode>>(simulation, "center")
			?.x(dimensions.width / 2)
			.y(dimensions.height / 2);
		forceOf<ForceManyBody<InternalNode>>(simulation, "charge")?.distanceMax(
			Math.min(dimensions.width, dimensions.height) *
				applied.params.chargeFraction,
		);

		applied.width = dimensions.width;
		applied.height = dimensions.height;
		// A new panel size may need a larger zoom as well as a smaller one
		armAutoFit(autoFitRef.current);
		if (!pausedRef.current) {
			simulation.alpha(Math.max(simulation.alpha(), 0.1)).restart();
		}
	}, [dimensions]);

	// Force parameters: update the running forces in place
	useEffect(() => {
		const simulation = simulationRef.current;
		const applied = appliedRef.current;
		if (!simulation || !applied || applied.params === params) return;

		forceOf<ForceManyBody<InternalNode>>(simulation, "charge")
			?.strength(params.chargeStrength)
			.distanceMax(
				Math.min(applied.width, applied.height) * params.chargeFraction,
			);
		nnForceRef.current
			?.setStrength(params.nnStrength)
			.setCMed(params.cMed)
			.setDAdj(params.dAdj);
		fpForceRef.current?.setStrength(params.fpStrength);
		// Re-reads the collision multiplier (paramsRef) for every node
		forceOf<ForceCollide<InternalNode>>(simulation, "collision")?.radius(
			(d) =>
				radiusOfRef.current((d as InternalNode).id) *
				paramsRef.current.collisionRadius,
		);

		applied.params = params;
		if (!pausedRef.current) {
			simulation.alpha(Math.max(simulation.alpha(), 0.5)).restart();
		}
	}, [params]);

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
			(d) =>
				radiusOfRef.current((d as InternalNode).id) *
				paramsRef.current.collisionRadius,
		);
		applied.radiusSignature = radiusSignature;
	}, [radiusSignature]);

	const pauseLabel = paused ? t`Resume physics` : t`Pause physics`;

	return (
		<div ref={containerRef} className={`relative h-full w-full ${className}`}>
			<svg
				ref={svgRef}
				width={dimensions.width}
				height={dimensions.height}
				style={{ backgroundColor }}
				className="h-full w-full"
				role="img"
				aria-label={t`Local argument map`}
			/>

			<MapChromeButton
				label={pauseLabel}
				onClick={() => setPaused((p) => !p)}
				className="left-4"
			>
				{paused ? <PlayIcon size={24} /> : <PauseIcon size={24} />}
			</MapChromeButton>

			<MapChromeButton
				label={t`LocalMap Settings`}
				onClick={() => setShowSettings(!showSettings)}
				className="right-4"
			>
				<GearIcon size={24} />
			</MapChromeButton>

			{showSettings && (
				<MapSettingsPanel
					title={<Trans>LocalMap Forces</Trans>}
					onReset={resetToDefaults}
				>
					<MapSettingsSection first>
						<Trans>LocalMAP Paper Parameters</Trans>
					</MapSettingsSection>

					<RangeSetting
						label={<Trans>C_Med: {cMed.toFixed(1)}</Trans>}
						description={<Trans>Medium distance threshold (default: 10)</Trans>}
						min={1}
						max={50}
						step={1}
						value={cMed}
						onChange={(value) => setCMed(Number.parseFloat(value))}
					/>

					<RangeSetting
						label={<Trans>d̄_adj: {dAdj.toFixed(1)}</Trans>}
						description={<Trans>Avg low-dim distance (default: 10)</Trans>}
						min={1}
						max={50}
						step={1}
						value={dAdj}
						onChange={(value) => setDAdj(Number.parseFloat(value))}
					/>

					<MapSettingsSection>
						<Trans>Force Multipliers</Trans>
					</MapSettingsSection>

					<RangeSetting
						label={<Trans>Neighbor Attraction: {nnStrength.toFixed(2)}</Trans>}
						min={0}
						max={1}
						step={0.01}
						value={nnStrength}
						onChange={(value) => setNnStrength(Number.parseFloat(value))}
					/>

					<RangeSetting
						label={<Trans>Far Pair Repulsion: {fpStrength.toFixed(2)}</Trans>}
						min={0}
						max={10}
						step={0.1}
						value={fpStrength}
						onChange={(value) => setFpStrength(Number.parseFloat(value))}
					/>

					<MapSettingsSection>
						<Trans>Additional Forces</Trans>
					</MapSettingsSection>

					<RangeSetting
						label={<Trans>General Repulsion: {Math.abs(chargeStrength)}</Trans>}
						min={-100}
						max={0}
						step={1}
						value={chargeStrength}
						onChange={(value) => setChargeStrength(Number.parseInt(value, 10))}
					/>

					<RangeSetting
						label={
							<Trans>Collision Radius: {collisionRadius.toFixed(1)}x</Trans>
						}
						min={0.5}
						max={5}
						step={0.1}
						value={collisionRadius}
						onChange={(value) => setCollisionRadius(Number.parseFloat(value))}
					/>

					<RangeSetting
						label={
							<Trans>
								Charge Distance (viewport fraction): {chargeFraction.toFixed(2)}
							</Trans>
						}
						description={
							<Trans>
								Controls how far charge forces act (higher = more global)
							</Trans>
						}
						min={0.1}
						max={1.0}
						step={0.05}
						value={chargeFraction}
						onChange={(value) => setChargeFraction(Number.parseFloat(value))}
					/>
				</MapSettingsPanel>
			)}
		</div>
	);
};

/** Drag pins a node while held and releases it on drop; a paused map stops again. */
function createDrag(
	simulationRef: { current: Simulation<InternalNode> | null },
	pausedRef: { current: boolean },
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
			const simulation = simulationRef.current;
			if (!event.active) simulation?.alphaTarget(0.1);
			d.fx = null;
			d.fy = null;
			if (pausedRef.current) simulation?.stop();
		});
}

export interface LocalMapProps
	extends Omit<LocalMapGraphProps, "recentNodeIds"> {
	/** Called on a click with the node and when the walk will move on. */
	onActiveNodeChange?: (
		node: MapGraphNode | null,
		expiresAt: number | null,
		durationMs: number,
	) => void;
	walkIntervalMs?: number;
}

/** LocalMap graph with selection in the interaction store and recent-node scaling. */
export const LocalMap = memo(function LocalMap({
	nodes,
	onActiveNodeChange,
	walkIntervalMs = DEFAULT_WALK_INTERVAL_MS,
	...graphProps
}: LocalMapProps) {
	const recentNodeIds = useMemo(() => newestNodeIds(nodes), [nodes]);
	const nodeById = useMemo(
		() => new Map(nodes.map((node) => [node.id, node])),
		[nodes],
	);

	const sharedSelectedNodeId = useMapInteraction(
		(state) => state.selectedNodeId,
	);
	const setSharedSelectedNodeId = useMapInteraction(
		(state) => state.setSelectedNodeId,
	);

	const {
		onNodeClick: externalOnNodeClick,
		selectedId: _selectedId,
		...restGraphProps
	} = graphProps;

	const handleNodeClick = useCallback(
		(nodeId: string) => {
			const node = nodeById.get(nodeId);
			if (!node) return;

			// The MST walk restarts its interval on every selection, also of the
			// selected node
			setSharedSelectedNodeId(nodeId);
			onActiveNodeChange?.(node, Date.now() + walkIntervalMs, walkIntervalMs);
			externalOnNodeClick?.(nodeId);
		},
		[
			nodeById,
			externalOnNodeClick,
			setSharedSelectedNodeId,
			onActiveNodeChange,
			walkIntervalMs,
		],
	);

	return (
		<LocalMapGraph
			nodes={nodes}
			selectedId={sharedSelectedNodeId ?? undefined}
			onNodeClick={handleNodeClick}
			recentNodeIds={recentNodeIds}
			{...restGraphProps}
		/>
	);
});
