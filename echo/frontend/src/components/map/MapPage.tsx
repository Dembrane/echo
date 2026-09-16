import { plural, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Plural, Trans } from "@lingui/react/macro";
import {
	Badge,
	Button,
	Group,
	Loader,
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
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { baseColors, brandColors, stateColors } from "@/colors";
import { useWorkspace } from "@/hooks/useWorkspace";
import { isReadOnlyRole } from "@/lib/roles";
import { cn } from "@/lib/utils";
import {
	budgetState,
	budgetsToAdmit,
	LEGACY_BUDGET_BOUNDS,
	type MapBudgets,
	maximumAdmittedNodes,
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
import { filterNodesByType, typesKey, zeroTypeCounts } from "./data/scope";
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
	useProjectMapSummary,
} from "./hooks";
import {
	pendingClaimIds,
	useAutoFactCheck,
	useMapFactCheck,
} from "./hooks/useMapFactCheck";
import { useMapUrlState } from "./hooks/useMapUrlState";
import {
	type TitleRequester,
	useSelectionTitle,
} from "./hooks/useSelectionTitle";
import type { EdgeCounts } from "./layout/edgeBudget";
import { EMPTY_EDGES, useMapGeometry } from "./layout/useMapGeometry";
import { EmptyArgumentsState, OverBudgetState } from "./panels/BudgetStates";
import { ExplorePanel } from "./panels/ExplorePanel";
import { Legend } from "./panels/Legend";
import { MapSettingsMenu } from "./panels/MapSettingsMenu";
import type { ConversationHref, NodeInspection } from "./panels/NodeDetailCard";
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
			radius={hasResult ? 0 : undefined}
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

type MapExperienceProps = {
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
						onSelect: selectNode,
						related: relatedObjects(
							selectedNodeId,
							graph,
							nodesById,
							visibleIds,
						),
					}
				: null,
		[evidenceFor, graph, nodesById, selectNode, selectedNodeId, visibleIds],
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
							onActiveNodeChange={handleActiveNodeChange}
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
const ARGUMENT_TYPES: ObjectType[] = ["argument", "deduplicated_argument"];

const resultToken = (response: MapGraphResponse): string =>
	isMapPayloadV2(response)
		? (response.snapshot?.id ?? "")
		: (response.snapshot_id ?? response.id);

type MapAdmission = {
	key: string;
	projectId: string;
	scope: string | null;
	resultToken: string;
	budgets: MapBudgets;
};

const admissionKey = (
	projectId: string,
	response: MapGraphResponse,
	scope: string | null,
	count: number,
): string => {
	return [projectId, resultToken(response), scope ?? "", count].join("|");
};

export type MapPageProps = {
	projectId: string;
	workspaceId?: string | null;
	/** Fixture mode (local only): synthetic objects, no requests. */
	fixture?: MapFixtureId | null;
};

export const MapPage = ({ projectId, workspaceId, fixture }: MapPageProps) => {
	const offline = Boolean(fixture);
	const { workspace, workspaceId: contextWorkspaceId } = useWorkspace();
	const readOnly = isReadOnlyRole(workspace?.role);
	const [settings, updateSettings] = useMapSettings();
	const [urlState, setUrlState] = useMapUrlState();
	const [admission, setAdmission] = useState<MapAdmission | null>(null);
	const [showUnplaced, setShowUnplaced] = useState(false);

	const fixtureData = useMemo(
		() => (fixture ? fixtureMapData(fixture) : null),
		[fixture],
	);

	const mapQuery = useProjectMapSummary(offline ? "" : projectId);
	useMapEvents(offline ? "" : projectId);
	const generate = useGenerateMap(projectId);

	const projectResultToken = mapQuery.data?.current
		? resultToken(mapQuery.data.current)
		: null;
	const admissionForRequest =
		admission?.projectId === projectId &&
		admission.scope === urlState.scope &&
		(projectResultToken === null ||
			admission.resultToken === projectResultToken)
			? admission.budgets
			: null;
	const graphQuery = useMapGraph(
		projectId,
		{
			edgeLimit: admissionForRequest?.edgeLimit ?? settings.edgeLimit,
			nodeLimit: admissionForRequest?.nodeLimit ?? settings.nodeLimit,
			scope: urlState.scope,
			// The server chooses current complete consolidation or originals. An
			// explicit historical scope remains pinned to its requested result.
			types: null,
		},
		{ enabled: !offline },
	);
	const legacyMapQuery = useProjectMap(offline ? "" : projectId, {
		enabled: !offline && graphQuery.data === null,
	});
	// The previous graph stays on screen while a new scope loads.
	const isRefreshing = !offline && graphQuery.isPlaceholderData;

	// The v2 graph, else the legacy result while the graph endpoint is missing.
	const response: MapGraphResponse | null = fixtureData
		? fixtureData.response
		: graphQuery.data === null
			? (legacyMapQuery.data?.current ?? null)
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
	const counts = useMemo(() => graph?.counts ?? zeroTypeCounts(), [graph]);
	const scopedArgumentTypes = useMemo(() => {
		if (graph?.version === 1) return ["argument"] as ObjectType[];
		const scoped = graph?.scope.types?.filter((type) =>
			ARGUMENT_TYPES.includes(type),
		);
		if (!scoped || scoped.length === 0) return [];
		// Defensive compatibility for old mixed responses: a consolidation
		// replaces originals and must never render beside them.
		return scoped.includes("deduplicated_argument")
			? (["deduplicated_argument"] as ObjectType[])
			: (["argument"] as ObjectType[]);
	}, [graph]);
	const argumentCount = scopedArgumentTypes.reduce(
		(total, type) => total + (counts[type] ?? 0),
		0,
	);
	const currentAdmissionKey =
		response && graph
			? admissionKey(projectId, response, urlState.scope, argumentCount)
			: null;
	const activeAdmission =
		admission && admission.key === currentAdmissionKey ? admission : null;
	useEffect(() => {
		if (!admission) return;
		const changedScope =
			admission.projectId !== projectId || admission.scope !== urlState.scope;
		const changedResult =
			(currentAdmissionKey !== null && admission.key !== currentAdmissionKey) ||
			(projectResultToken !== null &&
				admission.resultToken !== projectResultToken);
		if (changedScope || changedResult) setAdmission(null);
	}, [
		admission,
		currentAdmissionKey,
		projectId,
		projectResultToken,
		urlState.scope,
	]);
	const budgets = activeAdmission?.budgets ?? budgetResolution.budgets;
	const visibleSet = useMemo(
		() => new Set<ObjectType>(scopedArgumentTypes),
		[scopedArgumentTypes],
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

	const visibleCount = graph?.overBudget ? argumentCount : listNodes.length;
	const entry =
		graph?.overBudget && !activeAdmission
			? "overBudget"
			: budgetState(visibleCount, budgets.nodeLimit);

	const colorBy = urlState.colorBy ?? settings.colorBy;
	const handleColorByChange = useCallback(
		(next: ColorBy) => {
			updateSettings({ colorBy: next });
			setUrlState({ colorBy: next });
		},
		[setUrlState, updateSettings],
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

	const sourceCount = fixtureData
		? null
		: (mapQuery.data?.source?.conversations_with_transcripts ?? null);
	const nothingToRead = sourceCount === 0;
	const conversationCount = graph?.conversationCount ?? 0;
	const countsLine = graph
		? graph.version === 1
			? t`${plural(argumentCount, { one: "# argument", other: "# arguments" })} from ${plural(conversationCount, { one: "# conversation", other: "# conversations" })}`
			: plural(argumentCount, { one: "# argument", other: "# arguments" })
		: null;

	const isLoading =
		!offline &&
		(mapQuery.isLoading ||
			graphQuery.isLoading ||
			(graphQuery.data === null &&
				legacyMapQuery.isFetching &&
				!legacyMapQuery.data));
	const isError =
		!offline &&
		(graphQuery.isError ||
			(graphQuery.data === null && legacyMapQuery.isError));
	const failedAttempt = attempt?.status === "failed" ? attempt : null;
	const unplacedCount = listNodes.length - placedNodes.length;

	const experience = graph && (
		<MapInteractionProvider key={resultId}>
			<MapExperience
				graph={graph}
				placedNodes={placedNodes}
				visibleIds={visibleIds}
				budgets={budgets}
				colorBy={colorBy}
				onColorByChange={handleColorByChange}
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
				<Skeleton height={420} radius={0} />
			</Stack>
		);
	} else if (isRefreshing && activeAdmission) {
		body = (
			<Group gap="xs" className="px-4 md:px-6" aria-live="polite">
				<Loader size={16} color="primary" />
				<Text size="sm">
					<Trans>Loading the map.</Trans>
				</Text>
			</Group>
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
	} else if (entry === "empty" && graph.version === 1) {
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
				<EmptyArgumentsState />
			</div>
		);
	} else if (entry === "overBudget") {
		const admit = budgetsToAdmit(visibleCount, budgets, bounds);
		body = (
			<Stack gap="md" className="min-h-0 flex-1">
				<div className="px-4 md:px-6">
					<OverBudgetState
						count={visibleCount}
						admit={admit}
						maximumCount={maximumAdmittedNodes(bounds)}
						onRaise={(next) => {
							if (!currentAdmissionKey || !response) return;
							setAdmission({
								budgets: next,
								key: currentAdmissionKey,
								projectId,
								resultToken: resultToken(response),
								scope: urlState.scope,
							});
						}}
					/>
				</div>
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
					{graph && argumentCount > 0 && (
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
				(isRefreshing && !activeAdmission) ||
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
								one="# argument could not be placed on the map."
								other="# arguments could not be placed on the map."
							/>
							<Button
								size="compact-sm"
								variant="subtle"
								radius={0}
								onClick={() => setShowUnplaced((shown) => !shown)}
							>
								{showUnplaced ? (
									<Trans>Hide missing arguments</Trans>
								) : (
									<Trans>Inspect missing arguments</Trans>
								)}
							</Button>
						</Notice>
					)}
					{(graph?.stale.length ?? 0) > 0 && (
						<Notice>
							<Trans>Some arguments are based on an earlier analysis.</Trans>
						</Notice>
					)}
					{urlState.scope && (
						<Group gap="xs">
							<Text size="sm">
								<Trans>Showing the arguments of one result.</Trans>
							</Text>
							<Button
								size="compact-sm"
								variant="subtle"
								radius={0}
								onClick={() => setUrlState({ scope: null })}
							>
								<Trans>Show current arguments</Trans>
							</Button>
						</Group>
					)}
					{isRefreshing && !activeAdmission && (
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

			{showUnplaced && unplacedCount > 0 && (
				<div className="px-4 pb-2 md:px-6">
					<ResultList
						nodes={listNodes.filter((node) => unplacedIds.has(node.id))}
						unplacedIds={unplacedIds}
					/>
				</div>
			)}

			{body}
		</div>
	);
};
