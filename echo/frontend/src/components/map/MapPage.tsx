import { plural, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Plural, Trans } from "@lingui/react/macro";
import {
	Badge,
	Button,
	Group,
	Loader,
	SegmentedControl,
	Skeleton,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { WarningCircleIcon } from "@phosphor-icons/react";
import {
	type CSSProperties,
	type ReactNode,
	useCallback,
	useMemo,
	useRef,
	useState,
} from "react";
import { baseColors, brandColors, stateColors } from "@/colors";
import { useWorkspace } from "@/hooks/useWorkspace";
import { isReadOnlyRole } from "@/lib/roles";
import { cn } from "@/lib/utils";
import { OBJECT_TYPES } from "./attributes";
import {
	budgetState,
	budgetsToAdmit,
	LEGACY_BUDGET_BOUNDS,
	type MapBudgets,
	resolveBudgets,
} from "./budgets";
import {
	buildMapGraph,
	factCheckFor,
	factCheckSignature,
	isMapPayloadV2,
	type MapGraphData,
	withFactChecks,
} from "./data/adapter";
import { fixtureMapData, type MapFixtureId } from "./data/fixture";
import { relatedObjects } from "./data/relations";
import {
	argumentsDominate,
	countForTypes,
	filterNodesByType,
	resolveVisibleTypes,
	typesKey,
	zeroTypeCounts,
} from "./data/scope";
import { MAP_EDGE_GREY } from "./graph/nodeStyle";
import {
	type FactCheckStates,
	isAttemptRunning,
	type MapAttempt,
	type MapGraphResponse,
	useGenerateMap,
	useMapEvents,
	useMapGraph,
	useProjectMap,
} from "./hooks";
import {
	pendingClaimIds,
	useAutoFactCheck,
	useMapFactCheck,
} from "./hooks/useMapFactCheck";
import { type MapView, useMapUrlState } from "./hooks/useMapUrlState";
import {
	type TitleRequester,
	useSelectionTitle,
} from "./hooks/useSelectionTitle";
import type { EdgeCounts } from "./layout/edgeBudget";
import { EMPTY_EDGES, useMapGeometry } from "./layout/useMapGeometry";
import { EmptyObjectsState, OverBudgetState } from "./panels/BudgetStates";
import { ExplorePanel } from "./panels/ExplorePanel";
import { Legend } from "./panels/Legend";
import { MapSettingsMenu } from "./panels/MapSettingsMenu";
import type { ConversationHref, NodeInspection } from "./panels/NodeDetailCard";
import { ObjectsFilter, ObjectsFilterList } from "./panels/ObjectsFilter";
import { ResultList } from "./panels/ResultList";
import { ShowcasePanel } from "./panels/ShowcasePanel";
import { SpotlightPanel } from "./panels/SpotlightPanel";
import { mapVars } from "./panels/shared";
import { LocalMap } from "./renderers/LocalMapGraph";
import { DEFAULT_WALK_INTERVAL_MS, MstMap } from "./renderers/MstGraph";
import {
	MapInteractionProvider,
	useMapInteraction,
	useMapInteractionStore,
} from "./state/interactionStore";
import { type MapSettings, useMapSettings } from "./state/settings";
import type {
	ColorBy,
	FactCheckState,
	MapGraphNode,
	ObjectType,
} from "./types";

// ---------------------------------------------------------------------------
// Map-scoped theme. Light follows the app; dark only paints the map area.
// ---------------------------------------------------------------------------

const LIGHT_VARS = {
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

const DARK_VARS = {
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
// Generation status
// ---------------------------------------------------------------------------

const progressLabel = (attempt: MapAttempt): string => {
	const progress = attempt.progress ?? {};
	if (attempt.status === "embedding") {
		const total = progress.embeddings_total;
		const done = progress.embeddings_done ?? 0;
		return typeof total === "number" && total > 0
			? t`Embedding arguments ${done} of ${total}`
			: t`Embedding arguments`;
	}
	if (attempt.status === "extracting") {
		const total = progress.conversations_total;
		const done = progress.conversations_done ?? 0;
		return typeof total === "number" && total > 0
			? t`Reading conversations ${done} of ${total}`
			: t`Reading conversations`;
	}
	return t`Waiting to start`;
};

const GenerationControls = ({
	hasResult,
	attempt,
	readOnly,
	isStarting,
	nothingToRead,
	onGenerate,
}: {
	hasResult: boolean;
	attempt: MapAttempt | null;
	readOnly: boolean;
	isStarting: boolean;
	// No conversation has a transcript yet: a first generation would be empty.
	nothingToRead: boolean;
	onGenerate: () => void;
}) => {
	if (isAttemptRunning(attempt) && attempt) {
		return (
			<Group gap="xs" wrap="nowrap" aria-live="polite">
				<Loader size={16} color="primary" />
				<Text size="sm">{progressLabel(attempt)}</Text>
			</Group>
		);
	}
	if (readOnly) return null;
	const failed = attempt?.status === "failed";
	return (
		<Button
			variant={hasResult ? "outline" : undefined}
			loading={isStarting}
			disabled={!hasResult && nothingToRead}
			onClick={onGenerate}
		>
			{failed ? (
				<Trans>Try again</Trans>
			) : hasResult ? (
				<Trans>Regenerate</Trans>
			) : (
				<Trans>Generate map</Trans>
			)}
		</Button>
	);
};

const Notice = ({ children }: { children: ReactNode }) => (
	<Group gap="xs" wrap="nowrap" align="flex-start">
		<WarningCircleIcon size={18} className="mt-0.5 shrink-0 text-salmon-800" />
		<Text size="sm">{children}</Text>
	</Group>
);

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
	argumentsOnly,
	edgeCounts = null,
	layoutFailed = false,
}: {
	title: ReactNode;
	count: number;
	argumentsOnly: boolean;
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
			{argumentsOnly ? (
				<Plural value={count} one="# argument" other="# arguments" />
			) : (
				<Plural value={count} one="# object" other="# objects" />
			)}
		</p>
	</div>
);

type MapExperienceProps = {
	graph: MapGraphData;
	/** Visible objects with a vector, filtered before any geometry. */
	placedNodes: MapGraphNode[];
	/** Visible objects, placed or not. */
	listNodes: MapGraphNode[];
	visibleIds: ReadonlySet<string>;
	unplacedIds: ReadonlySet<string>;
	view: MapView;
	/** False above the node budget: no layout starts. */
	mapAvailable: boolean;
	budgets: MapBudgets;
	colorBy: ColorBy;
	onColorByChange: (colorBy: ColorBy) => void;
	onReveal: (type: ObjectType) => void;
	settings: MapSettings;
	factCheckStates: FactCheckStates;
	onFactCheck: (nodeId: string, options?: { force?: boolean }) => void;
	onCancelFactCheck: (nodeId: string) => void;
	canFactCheck: boolean;
	conversationHref?: ConversationHref;
	offline: boolean;
};

type WalkState = {
	nodeId: string | null;
	expiresAt: number | null;
	durationMs: number;
};

const EMPTY_EVIDENCE: never[] = [];

const MapExperience = ({
	graph,
	placedNodes,
	listNodes,
	visibleIds,
	unplacedIds,
	view,
	mapAvailable,
	budgets,
	colorBy,
	onColorByChange,
	onReveal,
	settings,
	factCheckStates,
	onFactCheck,
	onCancelFactCheck,
	canFactCheck,
	conversationHref,
	offline,
}: MapExperienceProps) => {
	const { i18n } = useLingui();
	const showMap = mapAvailable && view === "map";

	// Renderers restyle from node metadata. Rebuild their node array only
	// when a displayed verdict changes, never for other fact-check fields.
	const signature = factCheckSignature(placedNodes, factCheckStates);
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the verdict signature
	const graphNodes = useMemo(
		() => withFactChecks(placedNodes, factCheckStates),
		[placedNodes, signature],
	);
	// One layout per filtered node set and budget, shared by both renderers
	// and the titles. The list view and an over-budget scope request none.
	const drawsMap = showMap && (settings.showTree || settings.showClusters);
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
		nodes: placedNodes,
		request: offline ? fixtureTitle : undefined,
		resultId: graph.resultId,
		snapshotId: graph.snapshotId,
	});

	const store = useMapInteractionStore();
	const selectedNodeId = useMapInteraction((state) => state.selectedNodeId);
	const [walk, setWalk] = useState<WalkState>({
		durationMs: DEFAULT_WALK_INTERVAL_MS,
		expiresAt: null,
		nodeId: null,
	});
	const handleActiveNodeChange = useCallback(
		(node: MapGraphNode | null, expiresAt: number | null, durationMs: number) =>
			setWalk({ durationMs, expiresAt, nodeId: node?.id ?? null }),
		[],
	);

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
						onReveal,
						onSelect: selectNode,
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
			onReveal,
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
						related: [],
					}
				: null,
		[evidenceFor, graph, nodesById, walk.nodeId],
	);

	const { showExplore, showShowcase, showSpotlight, showTree, showClusters } =
		settings;
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
	const argumentsOnly = placedNodes.every(
		(node) => node.metadata.objectType === "argument",
	);

	return (
		<div className="grid h-full min-h-0 grid-cols-12 grid-rows-[minmax(0,1fr)] gap-2">
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
					{showExplore && showMap && (
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
					{showShowcase && showMap && (
						<div className="min-h-0 flex-1 overflow-hidden">
							<ShowcasePanel
								node={showcase.node}
								evidence={
									(showcase.node && graph.evidenceById.get(showcase.node.id)) ||
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

			{!showMap && (
				<section
					className={cn(
						SPAN_ALL[availableCols],
						"relative flex min-h-0 flex-col p-2",
					)}
				>
					<ResultList nodes={listNodes} unplacedIds={unplacedIds} />
				</section>
			)}

			{showMap && showTree && (
				<section
					id="argument-tree"
					className={cn(treeSpan, "relative flex min-h-0 flex-col p-2")}
				>
					<MapSectionHeader
						title={<Trans>Argument tree (MST)</Trans>}
						count={graphNodes.length}
						argumentsOnly={argumentsOnly}
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
							onActiveNodeChange={handleActiveNodeChange}
							timerActive={title.timerActive}
							timerProgress={title.timerProgress}
							// The walk serves the Showcase; it must not move the
							// analyst's selection while only Spotlight is open.
							autoAdvance={showShowcase}
						/>
					</div>
					{settings.showLegend && (
						<Legend colorBy={colorBy} darkMode={settings.darkMode} />
					)}
				</section>
			)}

			{showMap && showClusters && (
				<section
					id="localmap"
					className={cn(clustersSpan, "relative flex min-h-0 flex-col p-2")}
				>
					<MapSectionHeader
						title={<Trans>Local map</Trans>}
						count={graphNodes.length}
						argumentsOnly={argumentsOnly}
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
							onActiveNodeChange={handleActiveNodeChange}
							timerActive={title.timerActive}
							timerProgress={title.timerProgress}
						/>
					</div>
				</section>
			)}

			{showMap && !showTree && !showClusters && (
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
	);
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/** What makes two responses the same graph: a refetch keeps node identity. */
const graphIdentity = (response: MapGraphResponse): string => {
	if (isMapPayloadV2(response)) {
		return [
			"v2",
			response.snapshot?.id,
			typesKey(response.scope?.types ?? []),
			response.scope?.resultScope ?? "",
			response.budgets?.nodeLimit,
			response.budgets?.edgeLimit,
			response.overBudget ? "over" : "fits",
			response.nodes?.length ?? 0,
		].join("|");
	}
	return `v1|${response.id}`;
};

function useStableGraph(
	response: MapGraphResponse | null,
): MapGraphData | null {
	const ref = useRef<{ id: string; graph: MapGraphData } | null>(null);
	if (!response) return null;
	const id = graphIdentity(response);
	if (ref.current?.id !== id) {
		ref.current = { graph: buildMapGraph(response), id };
	}
	return ref.current.graph;
}

const MapSurface = ({
	darkMode,
	children,
}: {
	darkMode: boolean;
	children: ReactNode;
}) => (
	<div
		className="min-h-0 flex-1 p-2"
		style={{
			...(darkMode ? DARK_VARS : {}),
			backgroundColor: mapVars.surface,
			color: mapVars.text,
			minHeight: 480,
		}}
		data-map-dark={darkMode || undefined}
	>
		{children}
	</div>
);

const EMPTY_STATES: FactCheckStates = {};

export type MapPageProps = {
	projectId: string;
	workspaceId?: string | null;
	/** Fixture mode (local only): synthetic objects, no requests. */
	fixture?: MapFixtureId | null;
	/**
	 * Starts the recipe that creates objects of a type other than arguments.
	 * Called only from an explicit generate action, never from a filter change.
	 */
	onGenerateObjects?: (type: ObjectType) => void;
};

export const MapPage = ({
	projectId,
	workspaceId,
	fixture,
	onGenerateObjects,
}: MapPageProps) => {
	const offline = Boolean(fixture);
	const { workspace, workspaceId: contextWorkspaceId } = useWorkspace();
	const readOnly = isReadOnlyRole(workspace?.role);
	const [settings, updateSettings] = useMapSettings();
	const [urlState, setUrlState] = useMapUrlState();

	const fixtureData = useMemo(
		() => (fixture ? fixtureMapData(fixture) : null),
		[fixture],
	);

	const mapQuery = useProjectMap(offline ? "" : projectId);
	useMapEvents(offline ? "" : projectId);
	const generate = useGenerateMap(projectId);

	const requestedTypes = urlState.types ?? settings.types;
	const graphQuery = useMapGraph(
		projectId,
		{
			edgeLimit: settings.edgeLimit,
			nodeLimit: settings.nodeLimit,
			scope: urlState.scope,
			types: requestedTypes,
		},
		{ enabled: !offline },
	);
	// The previous graph stays on screen while a new scope loads.
	const isRefreshing = !offline && graphQuery.isPlaceholderData;

	// The v2 graph, else the legacy result while the graph endpoint is missing.
	const response: MapGraphResponse | null = fixtureData
		? fixtureData.response
		: graphQuery.data === null
			? (mapQuery.data?.current ?? null)
			: (graphQuery.data ?? null);
	const graph = useStableGraph(response);
	const attempt = fixtureData ? null : (mapQuery.data?.attempt ?? null);

	const bounds = graph?.budgetBounds ?? LEGACY_BUDGET_BOUNDS;
	const budgetResolution = useMemo(
		() =>
			resolveBudgets(
				{ edgeLimit: settings.edgeLimit, nodeLimit: settings.nodeLimit },
				bounds,
			),
		[bounds, settings.edgeLimit, settings.nodeLimit],
	);
	const budgets =
		isRefreshing && graph?.serverBudgets
			? graph.serverBudgets
			: budgetResolution.budgets;

	const counts = useMemo(() => graph?.counts ?? zeroTypeCounts(), [graph]);
	// While a new scope loads, the previous graph keeps the types it was made for.
	const viewRequestedTypes = isRefreshing
		? (graph?.scope.types ?? requestedTypes)
		: requestedTypes;
	const visibleTypes = resolveVisibleTypes({
		counts,
		nodeLimit: budgets.nodeLimit,
		requested: viewRequestedTypes,
		serverTypes: graph?.scope.types ?? null,
	});
	const selectedTypes = resolveVisibleTypes({
		counts,
		nodeLimit: budgets.nodeLimit,
		requested: requestedTypes,
		serverTypes: graph?.scope.types ?? null,
	});
	const visibleKey = typesKey(visibleTypes);
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the type selection
	const visibleSet = useMemo(
		() => new Set<ObjectType>(visibleTypes),
		[visibleKey],
	);

	// Filters narrow the nodes before any geometry; colour never does.
	const listNodes = useMemo(
		() => (graph ? filterNodesByType(graph.allNodes, visibleSet) : EMPTY_NODES),
		[graph, visibleSet],
	);
	const placedNodes = useMemo(
		() =>
			graph ? filterNodesByType(graph.placedNodes, visibleSet) : EMPTY_NODES,
		[graph, visibleSet],
	);
	const visibleIds = useMemo(
		() => new Set(listNodes.map((node) => node.id)),
		[listNodes],
	);
	const unplacedIds = useMemo(
		() => new Set((graph?.unplaced ?? []).map((item) => item.id)),
		[graph],
	);

	const totalCount = countForTypes(counts, OBJECT_TYPES);
	const visibleCount = graph?.overBudget
		? countForTypes(counts, visibleTypes)
		: listNodes.length;
	const entry = graph?.overBudget
		? "overBudget"
		: budgetState(visibleCount, budgets.nodeLimit);
	const mapAvailable = entry === "small" || entry === "map";
	const view: MapView =
		entry === "overBudget"
			? "list"
			: (urlState.view ?? (entry === "small" ? "list" : "map"));

	const colorBy = urlState.colorBy ?? settings.colorBy;
	const handleColorByChange = useCallback(
		(next: ColorBy) => {
			updateSettings({ colorBy: next });
			setUrlState({ colorBy: next });
		},
		[setUrlState, updateSettings],
	);
	const handleTypesChange = useCallback(
		(types: ObjectType[]) => {
			updateSettings({ types });
			setUrlState({ types });
		},
		[setUrlState, updateSettings],
	);
	const handleReveal = useCallback(
		(type: ObjectType) =>
			handleTypesChange(
				OBJECT_TYPES.filter(
					(item) => item === type || selectedTypes.includes(item),
				),
			),
		[handleTypesChange, selectedTypes],
	);

	const resultId = graph?.resultId ?? "";
	const factCheck = useMapFactCheck({
		initialStates: fixtureData?.factChecks,
		offline,
		readOnly,
		resultId,
	});
	const factCheckStates = factCheck.states ?? EMPTY_STATES;
	const { ready: factCheckReady, runAll } = factCheck;

	useAutoFactCheck({
		enabled:
			!readOnly && settings.autoFactCheckClaims && colorBy === "factCheck",
		nodes: placedNodes,
		ready: factCheckReady,
		resultId,
		runAll,
		states: factCheckStates,
	});

	// Before the saved states load every claim looks idle: nothing is pending.
	const pendingClaims = useMemo(
		() => (factCheckReady ? pendingClaimIds(placedNodes, factCheckStates) : []),
		[factCheckReady, placedNodes, factCheckStates],
	);
	const handleFactCheckAll = useCallback(
		() => runAll(pendingClaims),
		[pendingClaims, runAll],
	);

	const linkWorkspaceId = workspaceId ?? contextWorkspaceId;
	const conversationHref = useCallback<ConversationHref>(
		(conversationId) => {
			if (offline) return null;
			const base = linkWorkspaceId
				? `/w/${linkWorkspaceId}/projects/${projectId}`
				: `/projects/${projectId}`;
			return `${base}/conversations/${conversationId}`;
		},
		[linkWorkspaceId, offline, projectId],
	);

	const handleGenerate = useCallback(
		(type: ObjectType) => {
			if (type === "argument") {
				if (!offline && !readOnly) generate.mutate();
				return;
			}
			onGenerateObjects?.(type);
		},
		[generate, offline, onGenerateObjects, readOnly],
	);
	const canGenerate = useCallback(
		(type: ObjectType) =>
			!readOnly &&
			(type === "argument" ? !offline : Boolean(onGenerateObjects)),
		[offline, onGenerateObjects, readOnly],
	);

	const sourceCount = fixtureData
		? null
		: (mapQuery.data?.source?.conversations_with_transcripts ?? null);
	const nothingToRead = sourceCount === 0;
	const conversationCount = graph?.conversationCount ?? 0;
	const countsLine = graph
		? graph.version === 1
			? t`${plural(counts.argument, { one: "# argument", other: "# arguments" })} from ${plural(conversationCount, { one: "# conversation", other: "# conversations" })}`
			: t`${plural(totalCount, { one: "# object", other: "# objects" })} saved`
		: null;

	const isLoading =
		!offline &&
		(mapQuery.isLoading ||
			graphQuery.isLoading ||
			(graphQuery.data === null && mapQuery.isFetching && !mapQuery.data));
	const isError =
		!offline &&
		(graphQuery.isError || (graphQuery.data === null && mapQuery.isError));
	const failedAttempt = attempt?.status === "failed" ? attempt : null;
	const unplacedCount = listNodes.length - placedNodes.length;

	const filterList = (
		<ObjectsFilterList
			counts={counts}
			selected={selectedTypes}
			onChange={handleTypesChange}
			onGenerate={handleGenerate}
			canGenerate={canGenerate}
		/>
	);

	const experience = graph && (
		<MapInteractionProvider key={resultId}>
			<MapExperience
				graph={graph}
				placedNodes={placedNodes}
				listNodes={listNodes}
				visibleIds={visibleIds}
				unplacedIds={unplacedIds}
				view={view}
				mapAvailable={mapAvailable}
				budgets={budgets}
				colorBy={colorBy}
				onColorByChange={handleColorByChange}
				onReveal={handleReveal}
				settings={settings}
				factCheckStates={factCheckStates}
				onFactCheck={factCheck.run}
				onCancelFactCheck={factCheck.cancel}
				canFactCheck={!readOnly}
				conversationHref={conversationHref}
				offline={offline}
			/>
		</MapInteractionProvider>
	);

	let body: ReactNode;
	if (isLoading) {
		body = (
			<Stack gap="md" className="px-4 md:px-6">
				<Skeleton height={420} radius="md" />
			</Stack>
		);
	} else if (isError) {
		body = (
			<Text className="px-4 md:px-6">
				<Trans>The map could not be loaded. Try again in a moment.</Trans>
			</Text>
		);
	} else if (!graph) {
		body = (
			<Stack gap="sm" className="max-w-2xl px-4 md:px-6">
				{isAttemptRunning(attempt) ? (
					<Text>
						<Trans>
							The map is being generated. It appears here when it is ready.
						</Trans>
					</Text>
				) : nothingToRead ? (
					<Text>
						<Trans>
							This project has no conversations with transcripts yet. Generate a
							map once conversations have been transcribed.
						</Trans>
					</Text>
				) : readOnly ? (
					<Text>
						<Trans>No map has been generated for this project yet.</Trans>
					</Text>
				) : (
					<Text>
						<Trans>
							Map reads this project's transcripts, finds the arguments people
							make, and places related arguments close together. Generate a map
							to explore them.
						</Trans>
					</Text>
				)}
			</Stack>
		);
	} else if (entry === "empty" && graph.version === 1 && totalCount === 0) {
		body = (
			<Stack gap="sm" className="max-w-2xl px-4 md:px-6">
				<Text>
					{conversationCount === 0 ? (
						<Trans>
							This project has no conversations with transcripts yet. Generate a
							map once conversations have been transcribed.
						</Trans>
					) : (
						<Trans>
							No arguments were found in this project's conversations.
						</Trans>
					)}
				</Text>
			</Stack>
		);
	} else if (entry === "empty") {
		body = (
			<div className="px-4 md:px-6">
				<EmptyObjectsState
					totalCount={totalCount}
					selectedCount={selectedTypes.length}
				>
					{filterList}
				</EmptyObjectsState>
			</div>
		);
	} else if (entry === "overBudget") {
		const admit = budgetsToAdmit(visibleCount, budgets, bounds);
		body = (
			<Stack gap="md" className="min-h-0 flex-1">
				<div className="px-4 md:px-6">
					<OverBudgetState
						count={visibleCount}
						budgets={budgets}
						admit={admit}
						maxNodes={bounds.ceilings?.nodeLimit ?? null}
						onRaise={(next) =>
							updateSettings({
								edgeLimit: next.edgeLimit,
								nodeLimit: next.nodeLimit,
							})
						}
						filter={filterList}
						argumentsDominate={argumentsDominate(counts, visibleTypes)}
						onDeduplicate={
							canGenerate("deduplicated_argument")
								? () => handleGenerate("deduplicated_argument")
								: undefined
						}
					/>
				</div>
				{/* The objects stay inspectable in the list; no layout starts. */}
				{listNodes.length > 0 && (
					<MapSurface darkMode={settings.darkMode}>{experience}</MapSurface>
				)}
			</Stack>
		);
	} else {
		body = <MapSurface darkMode={settings.darkMode}>{experience}</MapSurface>;
	}

	return (
		<div className="flex h-full min-h-0 flex-col" style={LIGHT_VARS}>
			<div className="flex flex-wrap items-start justify-between gap-4 px-4 pb-2 pt-4 md:px-6">
				<Stack gap={2} className="min-w-0">
					<Group gap="sm" align="center" wrap="nowrap">
						<Title order={2}>
							<Trans>Map</Trans>
						</Title>
						<Badge size="sm" variant="light" color="primary">
							<Trans>Beta</Trans>
						</Badge>
					</Group>
					{countsLine && <Text size="sm">{countsLine}</Text>}
				</Stack>
				<Group gap="sm" wrap="nowrap">
					{graph && mapAvailable && (
						<SegmentedControl
							size="xs"
							value={view}
							onChange={(value) => setUrlState({ view: value as MapView })}
							data={[
								{ label: t`List`, value: "list" },
								{ label: t`Map`, value: "map" },
							]}
							aria-label={t`View`}
						/>
					)}
					{graph && totalCount > 0 && (
						<ObjectsFilter
							counts={counts}
							selected={selectedTypes}
							onChange={handleTypesChange}
							onGenerate={handleGenerate}
							canGenerate={canGenerate}
							visibleCount={visibleCount}
						/>
					)}
					{!offline && (
						<GenerationControls
							hasResult={Boolean(graph)}
							attempt={attempt}
							readOnly={readOnly}
							isStarting={generate.isPending}
							nothingToRead={nothingToRead}
							onGenerate={() => generate.mutate()}
						/>
					)}
					{graph && totalCount > 0 && (
						<MapSettingsMenu
							settings={settings}
							onChange={updateSettings}
							colorBy={colorBy}
							onColorByChange={handleColorByChange}
							budgets={budgetResolution}
							bounds={bounds}
							pendingClaimCount={pendingClaims.length}
							onFactCheckAll={handleFactCheckAll}
							canFactCheck={!readOnly}
						/>
					)}
				</Group>
			</div>

			{(failedAttempt ||
				unplacedCount > 0 ||
				urlState.scope ||
				isRefreshing ||
				(graph?.stale.length ?? 0) > 0) && (
				<Stack gap={4} className="px-4 pb-2 md:px-6">
					{failedAttempt && (
						<Notice>
							{graph ? (
								<Trans>
									The last generation failed, so this is still the previous map.{" "}
									{failedAttempt.error ?? ""}
								</Trans>
							) : (
								<Trans>
									The map could not be generated. {failedAttempt.error ?? ""}
								</Trans>
							)}
						</Notice>
					)}
					{unplacedCount > 0 && (
						<Notice>
							<Plural
								value={unplacedCount}
								one="# object could not be placed on the map. It is in the list."
								other="# objects could not be placed on the map. They are in the list."
							/>
						</Notice>
					)}
					{(graph?.stale.length ?? 0) > 0 && (
						<Notice>
							<Trans>Some objects are based on an earlier analysis.</Trans>
						</Notice>
					)}
					{urlState.scope && (
						<Group gap="xs">
							<Text size="sm">
								<Trans>Showing the objects of one result.</Trans>
							</Text>
							<Button
								size="compact-sm"
								variant="subtle"
								onClick={() => setUrlState({ scope: null, types: null })}
							>
								<Trans>Show all objects</Trans>
							</Button>
						</Group>
					)}
					{isRefreshing && (
						<Group gap="xs" aria-live="polite">
							<Loader size={14} color="primary" />
							<Text size="sm">
								<Trans>
									Loading the new scope. The current map stays until then.
								</Trans>
							</Text>
						</Group>
					)}
				</Stack>
			)}

			{body}
		</div>
	);
};
