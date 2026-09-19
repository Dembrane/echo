import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import {
	Button,
	Checkbox,
	Group,
	Paper,
	Popover,
	SegmentedControl,
	Stack,
	Text,
} from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import DembraneLoadingSpinner from "@/components/common/DembraneLoadingSpinner";
import {
	budgetsToAdmit,
	LEGACY_BUDGET_BOUNDS,
	type MapBudgets,
	maximumAdmittedNodes,
} from "@/components/map/budgets";
import type { EvidenceGroup } from "@/components/map/data/adapter";
import { buildMapGraph } from "@/components/map/data/adapter";
import type { MapGraphResponse } from "@/components/map/hooks";
import { useMapGeometry } from "@/components/map/layout/useMapGeometry";
import { OverBudgetState } from "@/components/map/panels/BudgetStates";
import { ShowcasePanel } from "@/components/map/panels/ShowcasePanel";
import { LocalMap } from "@/components/map/renderers/LocalMapGraph";
import { MstMap } from "@/components/map/renderers/MstGraph";
import {
	createMapInteractionStore,
	MapInteractionProvider,
	useMapInteraction,
} from "@/components/map/state/interactionStore";
import { useShowcaseWalk } from "@/components/map/state/useShowcaseWalk";
import type {
	ColorBy,
	FactCheckState,
	FactCheckVerdict,
	MapGraphNode,
	ObjectType,
} from "@/components/map/types";

type AudienceMapAdapterProps = {
	active: boolean;
	endpoint: string;
	revision?: number;
	waitingLabel?: string;
	/**
	 * The room's theme, read from the same session field the shell reads.
	 * "light" is the host's Map page exactly, so the default changes nothing.
	 */
	theme?: "light" | "dark";
};

/**
 * The Map already speaks two colour languages: the `--map-*` variables
 * MapPage scopes to its own page, and this app's `--app-background` /
 * `--app-text`, which every Mantine component in `src/theme.tsx` is pinned
 * to. Relighting both on one element under the shell turns the whole tab
 * dark without switching Mantine's colour scheme, which the light dashboard
 * around an embedded preview is still running in.
 *
 * The values are the audience shell's, not MapPage's: near-black room,
 * `#262625` panels, parchment ink, blue lifted to `#7C9BFF` where it is text
 * or a thin line.
 */
const DARK_MAP_VARS = {
	"--app-background": "#262625",
	"--app-text": "#F6F4F1",
	"--mantine-color-default": "#262625",
	"--mantine-color-default-border": "#3A3A38",
	"--mantine-color-default-color": "#F6F4F1",
	"--mantine-color-default-hover": "#3A3A38",
	"--mantine-color-dimmed": "color-mix(in srgb, #F6F4F1 64%, transparent)",
	"--mantine-color-text": "#F6F4F1",
	"--mantine-color-white": "#262625",
	"--map-accent-border": "color-mix(in srgb, #7C9BFF 60%, transparent)",
	"--map-accent-surface": "color-mix(in srgb, #7C9BFF 22%, transparent)",
	"--map-accent-text": "#7C9BFF",
	"--map-border": "#3A3A38",
	"--map-card": "color-mix(in srgb, #F6F4F1 8%, transparent)",
	// MapPage's dark mode keeps the light edge grey; over a near-black room it
	// glares, so the audience draws its edges as thinned parchment.
	"--map-edge": "color-mix(in srgb, #F6F4F1 45%, transparent)",
	"--map-error": "#FF9AA2",
	"--map-muted": "color-mix(in srgb, #F6F4F1 64%, transparent)",
	"--map-relation": "#F6F4F1",
	"--map-surface": "#1B1B1A",
	"--map-surface-raised": "#262625",
	"--map-text": "#F6F4F1",
} as CSSProperties;

/**
 * The Showcase reads the projection and nothing else: the room sees no
 * transcript quotes and no link back into the workspace.
 */
const NO_EVIDENCE: EvidenceGroup[] = [];

type AudienceMapResponse = MapGraphResponse & {
	fact_checks?: Record<string, unknown>;
};

/**
 * The room's map lives outside the bff prefix (a public token, or a preview
 * path), so the url is complete already and `bff.get` cannot build it. Errors
 * carry `status` like bff's do, so callers read failures the same way.
 *
 * Null is "no snapshot yet" (404), which is a state of the room, not a failure.
 */
const readAudienceMap = async (
	url: string,
	signal: AbortSignal,
): Promise<AudienceMapResponse | null> => {
	const response = await fetch(url, {
		credentials: "include",
		headers: { Accept: "application/json" },
		signal,
	});
	if (response.status === 404) return null;
	if (!response.ok) {
		throw Object.assign(new Error(`Map request failed (${response.status})`), {
			status: response.status,
		});
	}
	return (await response.json()) as AudienceMapResponse;
};

const FACT_CHECK_VERDICTS = new Set<FactCheckVerdict>([
	"contested",
	"false",
	"true",
	"unknown",
]);

const readAssessment = (value: unknown): FactCheckState | undefined => {
	if (!value || typeof value !== "object") return undefined;
	const assessment = value as Record<string, unknown>;
	if (
		assessment.status !== "done" ||
		typeof assessment.verdict !== "string" ||
		!FACT_CHECK_VERDICTS.has(assessment.verdict as FactCheckVerdict)
	) {
		return undefined;
	}
	return {
		checkedAt:
			typeof assessment.checkedAt === "string" ? assessment.checkedAt : "",
		justification:
			typeof assessment.justification === "string"
				? assessment.justification
				: "",
		sources: [],
		status: "done",
		verdict: assessment.verdict as FactCheckVerdict,
	};
};

const assessmentLabel = (assessment: FactCheckState) => {
	if (assessment.status !== "done") return null;
	switch (assessment.verdict) {
		case "true":
			return <Trans>Likely true</Trans>;
		case "false":
			return <Trans>Likely false</Trans>;
		case "contested":
			return <Trans>Contested</Trans>;
		case "unknown":
			return <Trans>Inconclusive</Trans>;
	}
};

const objectTypeLabel = (type: ObjectType) => {
	switch (type) {
		case "argument":
			return <Trans>Argument</Trans>;
		case "deduplicated_argument":
			return <Trans>Consolidated argument</Trans>;
		case "popcorn":
			return <Trans>Popcorn phrase</Trans>;
		case "stakeholder":
			return <Trans>Stakeholder</Trans>;
		case "tension":
			return <Trans>Tension</Trans>;
	}
};

const AudienceMapContent = ({
	nodes,
	graph,
	geometry,
	edgeLimit,
	showcase,
	onShowcaseChange,
	dark,
}: {
	nodes: MapGraphNode[];
	graph: ReturnType<typeof buildMapGraph>;
	geometry: ReturnType<typeof useMapGeometry>;
	edgeLimit: number;
	showcase: boolean;
	onShowcaseChange: (next: boolean) => void;
	dark: boolean;
}) => {
	const { i18n } = useLingui();
	const selectedNodeId = useMapInteraction((state) => state.selectedNodeId);
	const [showTree, setShowTree] = useState(true);
	const [showLocal, setShowLocal] = useState(true);
	const [showDetails, setShowDetails] = useState(true);
	const [colorBy, setColorBy] = useState<ColorBy>("none");
	// The tree renderer owns the walk's timer; this only keeps what it reports.
	const walk = useShowcaseWalk();
	const showcaseNode = walk.nodeId
		? (nodes.find((node) => node.id === walk.nodeId) ?? null)
		: null;
	const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;
	const selectedObject = selectedNode
		? graph.objectsById.get(selectedNode.id)
		: null;
	const assessment = selectedNode?.metadata.factCheck;
	const hasAssessments = nodes.some((node) => node.metadata.factCheck);
	const visibleMaps = Number(showTree) + Number(showLocal);

	return (
		<div className="flex h-full min-h-0 flex-col gap-2 p-3">
			<Group justify="space-between" gap="xs" wrap="wrap">
				<SegmentedControl
					size="xs"
					value={colorBy}
					onChange={(value) => setColorBy(value as ColorBy)}
					data={[
						{ label: <Trans>Neutral</Trans>, value: "none" },
						{ label: <Trans>Type</Trans>, value: "type" },
						...(hasAssessments
							? [
									{
										label: <Trans>Factual status</Trans>,
										value: "factCheck",
									},
								]
							: []),
					]}
				/>
				<Popover position="bottom-end" shadow="md" width={220}>
					<Popover.Target>
						<Button size="xs" variant="subtle">
							<Trans>Display</Trans>
						</Button>
					</Popover.Target>
					<Popover.Dropdown>
						<Stack gap="xs">
							<Checkbox
								checked={showcase}
								label={<Trans>Showcase</Trans>}
								onChange={(event) =>
									onShowcaseChange(event.currentTarget.checked)
								}
							/>
							<Checkbox
								checked={showTree}
								disabled={showTree && visibleMaps === 1}
								label={<Trans>Argument tree (MST)</Trans>}
								onChange={(event) => setShowTree(event.currentTarget.checked)}
							/>
							<Checkbox
								checked={showLocal}
								disabled={showLocal && visibleMaps === 1}
								label={<Trans>Local map</Trans>}
								onChange={(event) => setShowLocal(event.currentTarget.checked)}
							/>
							<Checkbox
								checked={showDetails}
								label={<Trans>Selected item details</Trans>}
								onChange={(event) =>
									setShowDetails(event.currentTarget.checked)
								}
							/>
						</Stack>
					</Popover.Dropdown>
				</Popover>
			</Group>

			<div
				className="grid min-h-0 flex-1 gap-2"
				style={{
					gridTemplateColumns: `${showcase ? "minmax(14rem,0.5fr) " : ""}${showTree && showLocal ? "minmax(0,1fr) minmax(0,1fr)" : "minmax(0,1fr)"}${showDetails ? " minmax(14rem,0.4fr)" : ""}`,
				}}
			>
				{showcase && (
					<Paper withBorder p="md" className="min-h-0 overflow-hidden">
						<ShowcasePanel
							node={showcaseNode}
							// Everything the room reads comes from the projection: the
							// statement, the assessment already in the payload, and no
							// quotes or links back into the workspace.
							evidence={NO_EVIDENCE}
							factCheck={showcaseNode?.metadata.factCheck}
							expiresAt={walk.expiresAt}
							durationMs={walk.durationMs}
							locale={i18n.locale}
						/>
					</Paper>
				)}
				{showTree && (
					<section
						className="min-h-0 overflow-hidden"
						aria-label="Argument tree"
					>
						<MstMap
							nodes={nodes}
							mstEdges={geometry.mstEdges}
							relations={graph.relations}
							edgeLimit={edgeLimit}
							showRelationships={false}
							colorBy={colorBy}
							darkMode={dark}
							onActiveNodeChange={walk.onActiveNodeChange}
							// The walk serves the Showcase, as it does on the host page:
							// no Showcase, no timer.
							autoAdvance={showcase}
						/>
					</section>
				)}
				{showLocal && (
					<section className="min-h-0 overflow-hidden" aria-label="Local map">
						<LocalMap
							nodes={nodes}
							neighbours={geometry.neighbours}
							mstEdges={geometry.mstEdges}
							relations={graph.relations}
							edgeLimit={edgeLimit}
							showRelationships={false}
							colorBy={colorBy}
							darkMode={dark}
							onActiveNodeChange={walk.onActiveNodeChange}
						/>
					</section>
				)}
				{showDetails && (
					<Paper withBorder p="md" className="min-h-0 overflow-auto">
						{selectedNode ? (
							<Stack gap="xs">
								<Text fw={600}>{selectedNode.label}</Text>
								<Text size="xs" c="dimmed">
									<Trans>Type</Trans>:{" "}
									{objectTypeLabel(selectedNode.metadata.objectType)}
								</Text>
								{selectedObject?.detail.type === "deduplicated_argument" &&
									selectedObject.detail.consolidation && (
										<Text size="sm">
											<Trans>
												Combines{" "}
												{selectedObject.detail.consolidation.memberCount} items
											</Trans>
										</Text>
									)}
								{assessment && assessment.status === "done" && (
									<Stack gap={4} mt="xs">
										<Text size="xs" tt="uppercase" c="dimmed">
											<Trans>Factual status</Trans>
										</Text>
										<Text size="sm" fw={600}>
											{assessmentLabel(assessment)}
										</Text>
										{assessment.justification && (
											<Text size="sm">{assessment.justification}</Text>
										)}
									</Stack>
								)}
							</Stack>
						) : (
							<Text size="sm" c="dimmed">
								<Trans>Select a node to see its details.</Trans>
							</Text>
						)}
					</Paper>
				)}
			</div>
		</div>
	);
};

const AudienceMap = ({
	payload,
	onAdmit,
	showcase,
	onShowcaseChange,
	dark,
}: {
	payload: MapGraphResponse;
	onAdmit: (budgets: MapBudgets) => void;
	showcase: boolean;
	onShowcaseChange: (next: boolean) => void;
	dark: boolean;
}) => {
	const graph = useMemo(() => buildMapGraph(payload), [payload]);
	const nodes = useMemo(() => {
		const assessments = (payload as AudienceMapResponse).fact_checks ?? {};
		return graph.placedNodes.map((node) => {
			const assessment = readAssessment(assessments[node.id]);
			if (!assessment) return node;
			return {
				...node,
				metadata: {
					...node.metadata,
					factCheck: assessment,
					// Audience projections expose an existing display classification,
					// never the capability to start or refresh a factual check.
					factCheckEligible: true,
				},
			};
		});
	}, [graph.placedNodes, payload]);
	const budgets =
		graph.serverBudgets ??
		graph.budgetBounds?.defaults ??
		LEGACY_BUDGET_BOUNDS.defaults;
	const geometry = useMapGeometry(nodes, { nodeLimit: budgets.nodeLimit });
	const [store] = useState(() =>
		createMapInteractionStore({ selectedNodeId: nodes[0]?.id ?? null }),
	);
	useEffect(() => {
		const selected = store.getState().selectedNodeId;
		if (selected && nodes.some((node) => node.id === selected)) return;
		store.setSelectedNodeId(nodes[0]?.id ?? null);
	}, [nodes, store]);

	if (graph.overBudget) {
		const count = Object.values(graph.counts).reduce(
			(total, value) => total + value,
			0,
		);
		const bounds = graph.budgetBounds ?? LEGACY_BUDGET_BOUNDS;
		return (
			<div className="flex h-full items-center justify-center p-6">
				<OverBudgetState
					count={count}
					admit={budgetsToAdmit(count, budgets, bounds)}
					maximumCount={maximumAdmittedNodes(bounds)}
					onRaise={onAdmit}
				/>
			</div>
		);
	}

	if (nodes.length === 0) {
		return (
			<div className="flex h-full items-center justify-center p-6">
				<Text size="lg" ta="center" maw={560}>
					<Trans>No map results are ready yet.</Trans>
				</Text>
			</div>
		);
	}

	return (
		<MapInteractionProvider store={store}>
			<AudienceMapContent
				nodes={nodes}
				graph={graph}
				geometry={geometry}
				edgeLimit={budgets.edgeLimit}
				showcase={showcase}
				onShowcaseChange={onShowcaseChange}
				dark={dark}
			/>
		</MapInteractionProvider>
	);
};

/**
 * A presentation-safe Map adapter. It reads a pre-sanitized projection and
 * never mounts host hooks for generation, fact checking, selection titles or
 * transcript links. The renderer is unmounted while hidden so its simulation,
 * its worker and the Showcase's walk stop doing background work.
 */
export const AudienceMapAdapter = ({
	active,
	endpoint,
	revision = 0,
	waitingLabel,
	theme = "light",
}: AudienceMapAdapterProps) => {
	const dark = theme === "dark";
	const queryClient = useQueryClient();
	const [admission, setAdmission] = useState<{
		endpoint: string;
		budgets: MapBudgets;
	} | null>(null);
	// Above the hidden boundary: the graph unmounts while another block is on
	// the wall, and the room comes back to the Showcase the host left running.
	const [showcase, setShowcase] = useState(false);
	const activeAdmission =
		admission?.endpoint === endpoint ? admission.budgets : null;
	const requestEndpoint = useMemo(() => {
		if (!activeAdmission) return endpoint;
		const url = new URL(endpoint, globalThis.location.origin);
		url.searchParams.set("node_limit", String(activeAdmission.nodeLimit));
		url.searchParams.set("edge_limit", String(activeAdmission.edgeLimit));
		return url.toString();
	}, [activeAdmission, endpoint]);
	// `revision` is deliberately not in the key: a new audience event re-reads
	// this same key, so the graph on the wall stays up while the read runs and
	// survives a read that fails. A raised budget is a different read.
	const queryKey = useMemo(
		() => [
			"presentation-audience-map",
			endpoint,
			activeAdmission?.nodeLimit ?? null,
			activeAdmission?.edgeLimit ?? null,
		],
		[activeAdmission, endpoint],
	);
	const query = useQuery<AudienceMapResponse | null>({
		// Hidden tab, no request.
		enabled: active,
		// The previous read of this same link, never another presentation's.
		placeholderData: (previous, previousQuery) =>
			previousQuery?.queryKey[1] === endpoint ? previous : undefined,
		queryFn: ({ signal }) => readAudienceMap(requestEndpoint, signal),
		queryKey,
		refetchOnReconnect: false,
		refetchOnWindowFocus: false,
		// One read per event. A failed read keeps what the room is looking at.
		retry: false,
		staleTime: Number.POSITIVE_INFINITY,
	});
	const { refetch } = query;

	const readRevision = useRef(revision);
	useEffect(() => {
		if (!active || readRevision.current === revision) return;
		readRevision.current = revision;
		void refetch();
	}, [active, refetch, revision]);

	// Hidden means idle: an in-flight read is dropped rather than left to
	// finish against a screen nobody is looking at.
	useEffect(() => {
		if (active) return;
		void queryClient.cancelQueries({ queryKey });
	}, [active, queryClient, queryKey]);

	const payload = query.data ?? null;

	if (!active) return null;
	// One themed root over every state, so the graph, the panels, the detail
	// card, the waiting line and the error all read the same variables.
	const inTheme = (content: ReactNode) => (
		<div
			className="h-full"
			data-theme={dark ? "dark" : undefined}
			data-testid="audience-map-root"
			style={dark ? DARK_MAP_VARS : undefined}
		>
			{content}
		</div>
	);
	// A 503 or a dropped read keeps the last graph, if there is one.
	if (payload) {
		return inTheme(
			<AudienceMap
				payload={payload}
				onAdmit={(budgets) => setAdmission({ budgets, endpoint })}
				showcase={showcase}
				onShowcaseChange={setShowcase}
				dark={dark}
			/>,
		);
	}
	if (query.isSuccess) {
		return inTheme(
			<div className="flex h-full items-center justify-center p-6">
				<Text size="lg" ta="center" maw={560}>
					{waitingLabel ?? <Trans>Map results are not ready yet.</Trans>}
				</Text>
			</div>,
		);
	}
	if (query.isError) {
		return inTheme(
			<div className="flex h-full items-center justify-center p-6" role="alert">
				<Stack gap="xs" align="center">
					<Text size="lg">
						<Trans>The map could not be loaded.</Trans>
					</Text>
				</Stack>
			</div>,
		);
	}
	return inTheme(
		<div className="relative h-full" aria-live="polite">
			<DembraneLoadingSpinner isLoading showMessage={false} />
		</div>,
	);
};
