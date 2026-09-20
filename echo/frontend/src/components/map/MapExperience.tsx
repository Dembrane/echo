import { useLingui } from "@lingui/react";
import { Plural, Trans } from "@lingui/react/macro";
import {
	type CSSProperties,
	type ReactNode,
	useCallback,
	useMemo,
	useState,
} from "react";
import { baseColors, brandColors, stateColors } from "@/colors";
import { cn } from "@/lib/utils";
import type { MapBudgets } from "./budgets";
import {
	factCheckFor,
	factCheckSignature,
	type MapGraphData,
	withFactChecks,
} from "./data/adapter";
import { relatedObjects } from "./data/relations";
import { MAP_EDGE_GREY } from "./graph/nodeStyle";
import type { FactCheckStates } from "./hooks";
import {
	type TitleRequester,
	useSelectionTitle,
} from "./hooks/useSelectionTitle";
import type { EdgeCounts } from "./layout/edgeBudget";
import { EMPTY_EDGES, useMapGeometry } from "./layout/useMapGeometry";
import { ArgumentAccordion } from "./panels/ArgumentAccordion";
import { ExplorePanel } from "./panels/ExplorePanel";
import { Legend } from "./panels/Legend";
import type { ConversationHref, NodeInspection } from "./panels/NodeDetailCard";
import { ShowcasePanel } from "./panels/ShowcasePanel";
import { SpotlightPanel } from "./panels/SpotlightPanel";
import { mapVars } from "./panels/shared";
import { LocalMap } from "./renderers/LocalMapGraph";
import { MstMap } from "./renderers/MstGraph";
import {
	useMapInteraction,
	useMapInteractionStore,
} from "./state/interactionStore";
import type { MapSettings } from "./state/settings";
import { useShowcaseWalk } from "./state/useShowcaseWalk";
import type { ColorBy, FactCheckState, MapGraphNode } from "./types";

// ---------------------------------------------------------------------------
// Map-scoped theme. Light follows the app; dark only paints the map area.
// ---------------------------------------------------------------------------

export const MAP_LIGHT_VARS = {
	"--map-accent-border": `color-mix(in srgb, ${baseColors.institutionBlue} 40%, transparent)`,
	"--map-accent-surface": `color-mix(in srgb, ${baseColors.institutionBlue} 12%, transparent)`,
	"--map-accent-text": baseColors.institutionBlue,
	"--map-border": "color-mix(in srgb, var(--app-text) 16%, transparent)",
	"--map-card": "color-mix(in srgb, var(--app-text) 6%, transparent)",
	"--map-edge": MAP_EDGE_GREY,
	"--map-error": stateColors.errorMark,
	"--map-muted": "color-mix(in srgb, var(--app-text) 62%, transparent)",
	"--map-surface": "var(--app-background)",
	"--map-surface-raised":
		"color-mix(in srgb, var(--app-background) 70%, white)",
	"--map-text": "var(--app-text)",
} as CSSProperties;

export const MAP_DARK_VARS = {
	"--map-accent-border": `color-mix(in srgb, ${baseColors.institutionBlue} 60%, transparent)`,
	"--map-accent-surface": `color-mix(in srgb, ${baseColors.institutionBlue} 30%, transparent)`,
	"--map-accent-text": brandColors.institutionBlue[3],
	"--map-border": `color-mix(in srgb, ${baseColors.parchment} 18%, transparent)`,
	"--map-card": `color-mix(in srgb, ${baseColors.parchment} 8%, transparent)`,
	"--map-edge": MAP_EDGE_GREY,
	"--map-error": baseColors.salmon,
	"--map-muted": `color-mix(in srgb, ${baseColors.parchment} 62%, transparent)`,
	"--map-surface": baseColors.graphite,
	"--map-surface-raised": `color-mix(in srgb, ${baseColors.graphite} 88%, ${baseColors.parchment})`,
	"--map-text": baseColors.parchment,
} as CSSProperties;

// ---------------------------------------------------------------------------
// The linked maps and panels for one result
// ---------------------------------------------------------------------------

const SPAN_ALL: Record<number, string> = {
	9: "col-span-9",
	12: "col-span-12",
};

const EMPTY_NODES: MapGraphNode[] = [];

const fixtureTitle: TitleRequester = (_resultId, nodeIds, signal) =>
	new Promise((resolve, reject) => {
		const timer = setTimeout(
			() =>
				resolve({ title: `Synthetic title for ${nodeIds.length} arguments` }),
			400,
		);
		signal.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(new DOMException("Aborted", "AbortError"));
		});
	});

/** Says when the edge budget leaves connections undrawn. */
const EdgeCountNote = ({ counts }: { counts: EdgeCounts | null }) => {
	if (!counts || counts.drawn >= counts.available) return null;
	const { drawn, available } = counts;
	return (
		<p className="text-xs">
			<Trans>
				Showing {drawn} of {available} connections
			</Trans>
		</p>
	);
};

const MapSectionHeader = ({
	title,
	count,
	edgeCounts = null,
	layoutFailed = false,
}: {
	title: ReactNode;
	count: number;
	edgeCounts?: EdgeCounts | null;
	/** The page's own copy; the layout's raw error is never shown. */
	layoutFailed?: boolean;
}) => (
	<div
		className="flex items-center justify-between gap-2 border-b pb-1"
		style={{ borderColor: mapVars.border }}
	>
		<h2 className="text-xs font-light uppercase tracking-wider">{title}</h2>
		{layoutFailed ? (
			<p className="text-xs" role="alert">
				<Trans>The layout could not be computed for this scope.</Trans>
			</p>
		) : (
			<EdgeCountNote counts={edgeCounts} />
		)}
		<p className="text-xs">
			<Plural value={count} one="# argument" other="# arguments" />
		</p>
	</div>
);

export type MapExperienceProps = {
	graph: MapGraphData;
	/** Visible arguments with a vector. */
	placedNodes: MapGraphNode[];
	visibleIds: ReadonlySet<string>;
	budgets: MapBudgets;
	colorBy: ColorBy;
	onColorByChange: (colorBy: ColorBy) => void;
	settings: MapSettings;
	factCheckStates: FactCheckStates;
	onFactCheck: (nodeId: string, options?: { force?: boolean }) => void;
	onCancelFactCheck: (nodeId: string) => void;
	canFactCheck: boolean;
	conversationHref?: ConversationHref;
	offline: boolean;
	/**
	 * False where nobody is signed in (a public presentation link): a settled
	 * highlight is never titled, no title request leaves the page, and the
	 * Explore panel that lists titles is not drawn.
	 */
	titles?: boolean;
	/** False where the payload withholds provenance: no source line is shown. */
	provenance?: boolean;
};

const EMPTY_EVIDENCE: never[] = [];

/**
 * The linked maps and their panels for one result. The host's Map page and
 * the presentation's room screen both draw this; what differs between them
 * arrives as props.
 */
export const MapExperience = ({
	graph,
	placedNodes,
	visibleIds,
	budgets,
	colorBy,
	onColorByChange,
	settings,
	factCheckStates,
	onFactCheck,
	onCancelFactCheck,
	canFactCheck,
	conversationHref,
	offline,
	titles = true,
	provenance = true,
}: MapExperienceProps) => {
	const { i18n } = useLingui();

	// Renderers restyle from node metadata. Rebuild their node array only
	// when a displayed verdict changes, never for other fact-check fields.
	const signature = factCheckSignature(placedNodes, factCheckStates);
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the verdict signature
	const graphNodes = useMemo(
		() => withFactChecks(placedNodes, factCheckStates),
		[placedNodes, signature],
	);
	// One layout per argument set and budget, shared by both renderers and titles.
	const drawsMap = settings.showTree || settings.showClusters;
	const geometry = useMapGeometry(drawsMap ? placedNodes : EMPTY_NODES, {
		nodeLimit: budgets.nodeLimit,
	});
	const mstEdges = geometry.mstEdges;
	const layoutFailed = geometry.status === "error";
	// Drawn and available connections per renderer, for the omitted-lines note.
	const [treeEdgeCounts, setTreeEdgeCounts] = useState<EdgeCounts | null>(null);
	const [localEdgeCounts, setLocalEdgeCounts] = useState<EdgeCounts | null>(
		null,
	);
	const nodesById = useMemo(
		() => new Map(graph.allNodes.map((node) => [node.id, node] as const)),
		[graph.allNodes],
	);

	const title = useSelectionTitle({
		edges: geometry.status === "ready" ? mstEdges : EMPTY_EDGES,
		enabled: titles,
		nodes: placedNodes,
		request: offline ? fixtureTitle : undefined,
		resultId: graph.resultId,
		snapshotId: graph.snapshotId,
	});

	const store = useMapInteractionStore();
	const selectedNodeId = useMapInteraction((state) => state.selectedNodeId);
	const walk = useShowcaseWalk();

	const evidenceFor = useCallback(
		(nodeId: string) => graph.evidenceById.get(nodeId) ?? EMPTY_EVIDENCE,
		[graph],
	);
	const selectNode = useCallback(
		(nodeId: string) => store.setSelectedNodeId(nodeId),
		[store],
	);

	const withState = (
		node: MapGraphNode | undefined,
	): { node: MapGraphNode | null; factCheck: FactCheckState | undefined } => {
		if (!node) return { factCheck: undefined, node: null };
		const factCheck = factCheckFor(node, factCheckStates);
		return {
			factCheck,
			node: factCheck
				? { ...node, metadata: { ...node.metadata, factCheck } }
				: node,
		};
	};
	const spotlight = withState(
		selectedNodeId ? nodesById.get(selectedNodeId) : undefined,
	);
	const showcase = withState(
		walk.nodeId ? nodesById.get(walk.nodeId) : undefined,
	);

	// Selecting never changes the filters; hidden related objects are listed
	// with an explicit reveal instead.
	const spotlightInspection = useMemo<NodeInspection | null>(
		() =>
			selectedNodeId && nodesById.has(selectedNodeId)
				? {
						evidenceFor,
						object: graph.objectsById.get(selectedNodeId) ?? null,
						onSelect: selectNode,
						provenance,
						related: relatedObjects(
							selectedNodeId,
							graph,
							nodesById,
							visibleIds,
						),
					}
				: null,
		[
			evidenceFor,
			graph,
			nodesById,
			provenance,
			selectNode,
			selectedNodeId,
			visibleIds,
		],
	);
	const showcaseInspection = useMemo<NodeInspection | null>(
		() =>
			walk.nodeId && nodesById.has(walk.nodeId)
				? {
						evidenceFor,
						object: graph.objectsById.get(walk.nodeId) ?? null,
						provenance,
						related: [],
					}
				: null,
		[evidenceFor, graph, nodesById, provenance, walk.nodeId],
	);

	const { showShowcase, showSpotlight, showTree, showClusters } = settings;
	const showExplore = settings.showExplore && titles;
	const hasLeftPanel = showExplore || showShowcase || showSpotlight;
	const availableCols = hasLeftPanel ? 9 : 12;
	const visibleMaps = (showTree ? 1 : 0) + (showClusters ? 1 : 0);
	const treeSpan =
		visibleMaps === 1
			? SPAN_ALL[availableCols]
			: hasLeftPanel
				? "col-span-5"
				: "col-span-6";
	const clustersSpan =
		visibleMaps === 1
			? SPAN_ALL[availableCols]
			: hasLeftPanel
				? "col-span-4"
				: "col-span-6";
	return (
		<div className="flex h-full min-h-0 flex-col">
			{/* The maps fill the view; the list of arguments waits under them. */}
			<div className="grid h-full shrink-0 grid-cols-12 grid-rows-[minmax(0,1fr)] gap-2">
				{hasLeftPanel && (
					<section className="col-span-3 flex min-h-0 flex-col gap-2 overflow-hidden p-2">
						{showSpotlight && (
							<div className="min-h-0 flex-1 overflow-hidden">
								<SpotlightPanel
									node={spotlight.node}
									evidence={
										(spotlight.node &&
											graph.evidenceById.get(spotlight.node.id)) ||
										EMPTY_EVIDENCE
									}
									factCheck={spotlight.factCheck}
									colorBy={colorBy}
									onColorByChange={onColorByChange}
									canFactCheck={canFactCheck}
									onFactCheck={onFactCheck}
									onCancelFactCheck={onCancelFactCheck}
									conversationHref={conversationHref}
									locale={i18n.locale}
									inspection={spotlightInspection}
								/>
							</div>
						)}
						{showExplore && (
							<div className="min-h-0 flex-1 overflow-hidden">
								<ExplorePanel
									isProcessing={title.isProcessing}
									error={title.error}
									onRetry={title.retry}
									history={title.history}
									nodesById={nodesById}
									selectedDistillationId={title.selectedDistillationId}
									onSelectDistillation={title.selectDistillation}
								/>
							</div>
						)}
						{showShowcase && (
							<div className="min-h-0 flex-1 overflow-hidden">
								<ShowcasePanel
									node={showcase.node}
									evidence={
										(showcase.node &&
											graph.evidenceById.get(showcase.node.id)) ||
										EMPTY_EVIDENCE
									}
									factCheck={showcase.factCheck}
									expiresAt={walk.expiresAt}
									durationMs={walk.durationMs}
									conversationHref={conversationHref}
									locale={i18n.locale}
									inspection={showcaseInspection}
								/>
							</div>
						)}
					</section>
				)}

				{showTree && (
					<section
						id="argument-tree"
						className={cn(treeSpan, "relative flex min-h-0 flex-col p-2")}
					>
						<MapSectionHeader
							title={<Trans>Argument tree (MST)</Trans>}
							count={graphNodes.length}
							edgeCounts={treeEdgeCounts}
							layoutFailed={layoutFailed}
						/>
						<div className="mt-3 min-h-0 flex-1 overflow-hidden">
							<MstMap
								nodes={graphNodes}
								mstEdges={mstEdges}
								relations={graph.relations}
								edgeLimit={budgets.edgeLimit}
								showRelationships={settings.showRelationships}
								onEdgeCounts={setTreeEdgeCounts}
								colorBy={colorBy}
								darkMode={settings.darkMode}
								onActiveNodeChange={walk.onActiveNodeChange}
								timerActive={title.timerActive}
								timerProgress={title.timerProgress}
								// The walk serves the Showcase; it must not move the
								// analyst's selection while only Spotlight is open.
								autoAdvance={showShowcase}
							/>
						</div>
						{settings.showLegend && (
							<Legend
								colorBy={colorBy}
								darkMode={settings.darkMode}
								conversations={graph.conversationSlotCount}
							/>
						)}
					</section>
				)}

				{showClusters && (
					<section
						id="localmap"
						className={cn(clustersSpan, "relative flex min-h-0 flex-col p-2")}
					>
						<MapSectionHeader
							title={<Trans>Local map</Trans>}
							count={graphNodes.length}
							edgeCounts={localEdgeCounts}
							layoutFailed={layoutFailed}
						/>
						<div className="mt-3 min-h-0 flex-1 overflow-hidden">
							<LocalMap
								nodes={graphNodes}
								neighbours={geometry.neighbours}
								mstEdges={mstEdges}
								relations={graph.relations}
								edgeLimit={budgets.edgeLimit}
								showRelationships={settings.showRelationships}
								onEdgeCounts={setLocalEdgeCounts}
								colorBy={colorBy}
								darkMode={settings.darkMode}
								onActiveNodeChange={walk.onActiveNodeChange}
								timerActive={title.timerActive}
								timerProgress={title.timerProgress}
							/>
						</div>
					</section>
				)}

				{!showTree && !showClusters && (
					<section
						className={cn(
							SPAN_ALL[availableCols],
							"relative flex flex-col items-center justify-center p-2",
						)}
					>
						<p className="text-sm">
							<Trans>Enable a visualization from the panel settings menu</Trans>
						</p>
					</section>
				)}
			</div>

			{/* The list carries the deck's tokens, which turn over on the nearest
			    dark theme. The room sets one on its own root; the host's Map page
			    has a dark switch of its own and says so here. */}
			<div
				className="px-2 pb-6 pt-8"
				data-theme={settings.darkMode ? "dark" : undefined}
			>
				<ArgumentAccordion
					nodes={graphNodes}
					mstEdges={mstEdges}
					evidenceFor={evidenceFor}
				/>
			</div>
		</div>
	);
};

export const MapSurface = ({
	darkMode,
	children,
	inset = true,
}: {
	darkMode: boolean;
	children: ReactNode;
	/**
	 * False where the surface sits in a pane that already keeps the room's
	 * edge, so the map does not inset itself a second time.
	 */
	inset?: boolean;
}) => (
	<div
		className={cn("min-h-0 flex-1 overflow-y-auto py-2", inset && "px-2")}
		style={{
			...(darkMode ? MAP_DARK_VARS : {}),
			backgroundColor: mapVars.surface,
			color: mapVars.text,
			minHeight: 480,
		}}
		data-map-dark={darkMode || undefined}
	>
		{children}
	</div>
);
