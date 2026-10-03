import { plural, t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	Alert,
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
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import { useWorkspace } from "@/hooks/useWorkspace";
import { isReadOnlyRole } from "@/lib/roles";
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
	isMapPayloadV2,
	type MapGraphData,
} from "./data/adapter";
import { conversationColor, conversationSlotLabel } from "./attributes";
import { fixtureMapData, type MapFixtureId } from "./data/fixture";
import {
	filterNodesByConversation,
	filterNodesByType,
	typesKey,
	zeroTypeCounts,
} from "./data/scope";
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
import { MAP_LIGHT_VARS, MapExperience, MapSurface } from "./MapExperience";
import { EmptyArgumentsState, OverBudgetState } from "./panels/BudgetStates";
import { MapSettingsMenu } from "./panels/MapSettingsMenu";
import type { ConversationHref } from "./panels/NodeDetailCard";
import { ResultList } from "./panels/ResultList";
import { MapInteractionProvider } from "./state/interactionStore";
import { useMapSettings } from "./state/settings";
import type { ColorBy, MapGraphNode, ObjectType } from "./types";

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
				<Loader size="sm" color="primary" />
				<Text size="sm">{progressLabel(attempt)}</Text>
			</Group>
		);
	}
	if (readOnly) return null;
	const failed = attempt?.status === "failed";
	return (
		<Button
			variant={hasResult ? undefined : "filled"}
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
		<WarningCircleIcon size={16} className="mt-0.5 shrink-0" />
		<Text size="sm">{children}</Text>
	</Group>
);

const EMPTY_NODES: MapGraphNode[] = [];

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

	// The conversations on this map, in palette order, and those left out.
	// A hidden id from another map (an old link) is no filter here.
	const conversations = useMemo(
		() =>
			Array.from(graph?.conversationSlots ?? [])
				.sort((a, b) => a[1] - b[1])
				.map(([id, slot]) => ({
					color: conversationColor(slot),
					id,
					name:
						graph?.conversationNames.get(slot) || conversationSlotLabel(slot),
				})),
		[graph],
	);
	const hiddenConversations = useMemo(
		() =>
			new Set(urlState.hidden.filter((id) => graph?.conversationSlots.has(id))),
		[graph, urlState.hidden],
	);

	// Filters narrow the nodes before any geometry; colour never does.
	const listNodes = useMemo(
		() =>
			graph
				? filterNodesByConversation(
						filterNodesByType(graph.allNodes, visibleSet),
						hiddenConversations,
					)
				: EMPTY_NODES,
		[graph, visibleSet, hiddenConversations],
	);
	const placedNodes = useMemo(
		() =>
			graph
				? filterNodesByConversation(
						filterNodesByType(graph.placedNodes, visibleSet),
						hiddenConversations,
					)
				: EMPTY_NODES,
		[graph, visibleSet, hiddenConversations],
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
				<Loader size="sm" color="primary" />
				<Text size="sm">
					<Trans>Loading the map.</Trans>
				</Text>
			</Group>
		);
	} else if (isError) {
		const loadError =
			graphQuery.error ??
			(graphQuery.data === null ? legacyMapQuery.error : null);
		body = (
			<div className="max-w-2xl px-4 md:px-6">
				<ErrorNotice
					error={loadError}
					title={t`The map could not be loaded`}
					onRetry={() => {
						if (graphQuery.isError) graphQuery.refetch();
						else legacyMapQuery.refetch();
					}}
				/>
			</div>
		);
	} else if (!graph) {
		body = (
			<Stack gap="sm" className="max-w-2xl px-4 md:px-6">
				{isAttemptRunning(attempt) ? (
					<Text size="sm" c="dimmed">
						<Trans>
							The map is being generated. It appears here when it is ready.
						</Trans>
					</Text>
				) : nothingToRead ? (
					<Text size="sm" c="dimmed">
						<Trans>
							This project has no conversations with transcripts yet. Generate a
							map once conversations have been transcribed.
						</Trans>
					</Text>
				) : readOnly ? (
					<Text size="sm" c="dimmed">
						<Trans>No map has been generated for this project yet.</Trans>
					</Text>
				) : (
					<Text size="sm" c="dimmed">
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
				<Text size="sm" c="dimmed">
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
		<div className="flex h-full min-h-0 flex-col" style={MAP_LIGHT_VARS}>
			{/* One row, to give the map the height: the title, what it holds and
			    its controls. A narrow screen drops the counts first. */}
			<Group
				gap="sm"
				align="center"
				justify="flex-start"
				wrap="nowrap"
				className="px-4 pb-2 pt-4 md:px-6"
			>
				<Title order={2}>
					<Trans>Map</Trans>
				</Title>
				<Badge size="sm" color="mauve" c="graphite">
					<Trans>Beta</Trans>
				</Badge>
				{countsLine && (
					<Text size="sm" c="dimmed" className="hidden truncate md:block">
						{countsLine}
					</Text>
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
						conversations={conversations}
						hiddenConversations={hiddenConversations}
						onHiddenConversationsChange={(hidden) =>
							setUrlState({ hidden: [...hidden] })
						}
					/>
				)}
			</Group>

			{(failedAttempt ||
				unplacedCount > 0 ||
				urlState.scope ||
				hiddenConversations.size > 0 ||
				(isRefreshing && !activeAdmission) ||
				(graph?.stale.length ?? 0) > 0) && (
				<Stack gap="xs" className="px-4 pb-2 md:px-6">
					{failedAttempt && (
						<Alert color="red" icon={<WarningCircleIcon size={20} />}>
							<Text size="sm">
								{graph ? (
									<Trans>
										The last generation failed, so this is still the previous
										map. {failedAttempt.error ?? ""}
									</Trans>
								) : (
									<Trans>
										The map could not be generated. {failedAttempt.error ?? ""}
									</Trans>
								)}
							</Text>
						</Alert>
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
								onClick={() => setUrlState({ scope: null })}
							>
								<Trans>Show current arguments</Trans>
							</Button>
						</Group>
					)}
					{hiddenConversations.size > 0 && (
						<Group gap="xs">
							<Text size="sm">
								<Plural
									value={hiddenConversations.size}
									one="# conversation is hidden from the map."
									other="# conversations are hidden from the map."
								/>
							</Text>
							<Button
								size="compact-sm"
								variant="subtle"
								onClick={() => setUrlState({ hidden: [] })}
							>
								<Trans>Show all conversations</Trans>
							</Button>
						</Group>
					)}
					{isRefreshing && !activeAdmission && (
						<Group gap="xs" aria-live="polite">
							<Loader size="sm" color="primary" />
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
