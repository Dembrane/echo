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
	useMemo,
	useRef,
	useState,
} from "react";
import { baseColors, brandColors, stateColors } from "@/colors";
import { useWorkspace } from "@/hooks/useWorkspace";
import { isReadOnlyRole } from "@/lib/roles";
import { cn } from "@/lib/utils";
import {
	buildMapGraph,
	factCheckFor,
	factCheckSignature,
	type MapGraphData,
	withFactChecks,
} from "./data/adapter";
import { fixtureMapResult } from "./data/fixture";
import { buildMST } from "./graph/mst";
import { MAP_EDGE_GREY } from "./graph/nodeStyle";
import {
	type FactCheckStates,
	isAttemptRunning,
	type MapAttempt,
	type MapResult,
	useGenerateMap,
	useMapEvents,
	useProjectMap,
} from "./hooks";
import {
	pendingClaimIds,
	useAutoFactCheck,
	useMapFactCheck,
} from "./hooks/useMapFactCheck";
import {
	type TitleRequester,
	useSelectionTitle,
} from "./hooks/useSelectionTitle";
import { ExplorePanel } from "./panels/ExplorePanel";
import { Legend } from "./panels/Legend";
import { MapSettingsMenu } from "./panels/MapSettingsMenu";
import type { ConversationHref } from "./panels/NodeDetailCard";
import { ShowcasePanel } from "./panels/ShowcasePanel";
import { SpotlightPanel } from "./panels/SpotlightPanel";
import { mapVars } from "./panels/shared";
import { LocalMap } from "./renderers/LocalMapGraph";
import { DEFAULT_WALK_INTERVAL_MS, MstMap } from "./renderers/MstGraph";
import {
	MapInteractionProvider,
	useMapInteraction,
} from "./state/interactionStore";
import { type MapSettings, useMapSettings } from "./state/settings";
import type { FactCheckState, MapGraphNode } from "./types";

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
	current,
	attempt,
	readOnly,
	isStarting,
	nothingToRead,
	onGenerate,
}: {
	current: MapResult | null;
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
			variant={current ? "outline" : undefined}
			loading={isStarting}
			disabled={!current && nothingToRead}
			onClick={onGenerate}
		>
			{failed ? (
				<Trans>Try again</Trans>
			) : current ? (
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

const MapSectionHeader = ({
	title,
	count,
}: {
	title: ReactNode;
	count: number;
}) => (
	<div
		className="flex items-center justify-between border-b pb-1"
		style={{ borderColor: mapVars.border }}
	>
		<h2 className="text-xs font-light uppercase tracking-wider">{title}</h2>
		<p className="text-xs">
			<Plural value={count} one="# argument" other="# arguments" />
		</p>
	</div>
);

type MapExperienceProps = {
	resultId: string;
	graph: MapGraphData;
	settings: MapSettings;
	onSettingsChange: (patch: Partial<MapSettings>) => void;
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

const MapExperience = ({
	resultId,
	graph,
	settings,
	onSettingsChange,
	factCheckStates,
	onFactCheck,
	onCancelFactCheck,
	canFactCheck,
	conversationHref,
	offline,
}: MapExperienceProps) => {
	const { i18n } = useLingui();
	const { placedNodes } = graph;

	// Renderers restyle from node metadata. Rebuild their node array only
	// when a displayed verdict changes, never for other fact-check fields.
	const signature = factCheckSignature(placedNodes, factCheckStates);
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the verdict signature
	const graphNodes = useMemo(
		() => withFactChecks(placedNodes, factCheckStates),
		[placedNodes, signature],
	);
	const mstEdges = useMemo(() => buildMST(placedNodes), [placedNodes]);
	const nodesById = useMemo(
		() => new Map(graph.allNodes.map((node) => [node.id, node] as const)),
		[graph.allNodes],
	);

	const title = useSelectionTitle({
		edges: mstEdges,
		nodes: placedNodes,
		request: offline ? fixtureTitle : undefined,
		resultId,
	});

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

	const onColorByChange = useCallback(
		(colorBy: MapSettings["colorBy"]) => onSettingsChange({ colorBy }),
		[onSettingsChange],
	);

	const emptyEvidence = useMemo(() => [], []);

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
									emptyEvidence
								}
								factCheck={spotlight.factCheck}
								colorBy={settings.colorBy}
								onColorByChange={onColorByChange}
								canFactCheck={canFactCheck}
								onFactCheck={onFactCheck}
								onCancelFactCheck={onCancelFactCheck}
								conversationHref={conversationHref}
								locale={i18n.locale}
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
									emptyEvidence
								}
								factCheck={showcase.factCheck}
								expiresAt={walk.expiresAt}
								durationMs={walk.durationMs}
								conversationHref={conversationHref}
								locale={i18n.locale}
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
					/>
					<div className="mt-3 min-h-0 flex-1 overflow-hidden">
						<MstMap
							nodes={graphNodes}
							colorBy={settings.colorBy}
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
						<Legend colorBy={settings.colorBy} darkMode={settings.darkMode} />
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
					/>
					<div className="mt-3 min-h-0 flex-1 overflow-hidden">
						<LocalMap
							nodes={graphNodes}
							colorBy={settings.colorBy}
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

/** One graph per result id: a refetch of the same revision keeps node identity. */
function useStableGraph(current: MapResult | null): MapGraphData | null {
	const ref = useRef<{ id: string; graph: MapGraphData } | null>(null);
	if (!current) return null;
	if (ref.current?.id !== current.id) {
		ref.current = { graph: buildMapGraph(current), id: current.id };
	}
	return ref.current.graph;
}

const EMPTY_STATES: FactCheckStates = {};

export type MapPageProps = {
	projectId: string;
	workspaceId?: string | null;
	/** Fixture mode (local only): synthetic nodes, no requests. */
	fixtureCount?: number | null;
};

export const MapPage = ({
	projectId,
	workspaceId,
	fixtureCount,
}: MapPageProps) => {
	const offline = Boolean(fixtureCount);
	const { workspace, workspaceId: contextWorkspaceId } = useWorkspace();
	const readOnly = isReadOnlyRole(workspace?.role);
	const [settings, updateSettings] = useMapSettings();

	const fixture = useMemo(
		() => (fixtureCount ? fixtureMapResult(fixtureCount) : null),
		[fixtureCount],
	);

	const mapQuery = useProjectMap(offline ? "" : projectId);
	useMapEvents(offline ? "" : projectId);
	const generate = useGenerateMap(projectId);

	const current = fixture ? fixture.result : (mapQuery.data?.current ?? null);
	const attempt = fixture ? null : (mapQuery.data?.attempt ?? null);
	const graph = useStableGraph(current);
	const resultId = current?.id ?? "";

	const factCheck = useMapFactCheck({
		initialStates: fixture?.factChecks,
		offline,
		readOnly,
		resultId,
	});
	const factCheckStates = factCheck.states ?? EMPTY_STATES;
	const placedNodes = graph?.placedNodes;
	const { ready: factCheckReady, runAll } = factCheck;

	useAutoFactCheck({
		enabled:
			!readOnly &&
			settings.autoFactCheckClaims &&
			settings.colorBy === "factCheck",
		nodes: placedNodes ?? [],
		ready: factCheckReady,
		resultId,
		runAll,
		states: factCheckStates,
	});

	// Before the saved states load every claim looks idle: nothing is pending.
	const pendingClaims = useMemo(
		() =>
			factCheckReady ? pendingClaimIds(placedNodes ?? [], factCheckStates) : [],
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

	const argumentCount = current?.arguments.length ?? 0;
	const conversationCount = current?.conversations.length ?? 0;
	const sourceCount = fixture
		? null
		: (mapQuery.data?.source?.conversations_with_transcripts ?? null);
	const nothingToRead = sourceCount === 0;
	const countsLine = current
		? t`${plural(argumentCount, { one: "# argument", other: "# arguments" })} from ${plural(conversationCount, { one: "# conversation", other: "# conversations" })}`
		: null;

	const isLoading = !offline && mapQuery.isLoading;
	const failedAttempt = attempt?.status === "failed" ? attempt : null;
	const unplacedCount = graph?.unplaced.length ?? 0;

	let body: ReactNode;
	if (isLoading) {
		body = (
			<Stack gap="md" className="px-4 md:px-6">
				<Skeleton height={420} radius="md" />
			</Stack>
		);
	} else if (!offline && mapQuery.isError) {
		body = (
			<Text className="px-4 md:px-6">
				<Trans>The map could not be loaded. Try again in a moment.</Trans>
			</Text>
		);
	} else if (!current || !graph) {
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
	} else if (current.arguments.length === 0) {
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
	} else {
		body = (
			<div
				className="min-h-0 flex-1 p-2"
				style={{
					...(settings.darkMode ? DARK_VARS : {}),
					backgroundColor: mapVars.surface,
					color: mapVars.text,
					minHeight: 480,
				}}
				data-map-dark={settings.darkMode || undefined}
			>
				<MapInteractionProvider key={resultId}>
					<MapExperience
						resultId={resultId}
						graph={graph}
						settings={settings}
						onSettingsChange={updateSettings}
						factCheckStates={factCheckStates}
						onFactCheck={factCheck.run}
						onCancelFactCheck={factCheck.cancel}
						canFactCheck={!readOnly}
						conversationHref={conversationHref}
						offline={offline}
					/>
				</MapInteractionProvider>
			</div>
		);
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
							current={current}
							attempt={attempt}
							readOnly={readOnly}
							isStarting={generate.isPending}
							nothingToRead={nothingToRead}
							onGenerate={() => generate.mutate()}
						/>
					)}
					{current && current.arguments.length > 0 && (
						<MapSettingsMenu
							settings={settings}
							onChange={updateSettings}
							pendingClaimCount={pendingClaims.length}
							onFactCheckAll={handleFactCheckAll}
							canFactCheck={!readOnly}
						/>
					)}
				</Group>
			</div>

			{(failedAttempt || unplacedCount > 0) && (
				<Stack gap={4} className="px-4 pb-2 md:px-6">
					{failedAttempt && (
						<Notice>
							{current ? (
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
						</Notice>
					)}
				</Stack>
			)}

			{body}
		</div>
	);
};
