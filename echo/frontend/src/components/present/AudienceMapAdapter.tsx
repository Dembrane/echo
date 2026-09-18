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
import { useEffect, useMemo, useState } from "react";
import DembraneLoadingSpinner from "@/components/common/DembraneLoadingSpinner";
import {
	budgetsToAdmit,
	LEGACY_BUDGET_BOUNDS,
	type MapBudgets,
	maximumAdmittedNodes,
} from "@/components/map/budgets";
import { buildMapGraph } from "@/components/map/data/adapter";
import type { MapGraphResponse } from "@/components/map/hooks";
import { useMapGeometry } from "@/components/map/layout/useMapGeometry";
import { OverBudgetState } from "@/components/map/panels/BudgetStates";
import { LocalMap } from "@/components/map/renderers/LocalMapGraph";
import { MstMap } from "@/components/map/renderers/MstGraph";
import {
	createMapInteractionStore,
	MapInteractionProvider,
	useMapInteraction,
} from "@/components/map/state/interactionStore";
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
};

type AudienceMapResponse = MapGraphResponse & {
	fact_checks?: Record<string, unknown>;
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
}: {
	nodes: MapGraphNode[];
	graph: ReturnType<typeof buildMapGraph>;
	geometry: ReturnType<typeof useMapGeometry>;
	edgeLimit: number;
}) => {
	const selectedNodeId = useMapInteraction((state) => state.selectedNodeId);
	const [showTree, setShowTree] = useState(true);
	const [showLocal, setShowLocal] = useState(true);
	const [showDetails, setShowDetails] = useState(true);
	const [colorBy, setColorBy] = useState<ColorBy>("none");
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
					gridTemplateColumns: `${showTree && showLocal ? "minmax(0,1fr) minmax(0,1fr)" : "minmax(0,1fr)"}${showDetails ? " minmax(14rem,0.4fr)" : ""}`,
				}}
			>
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
							autoAdvance={false}
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
}: {
	payload: MapGraphResponse;
	onAdmit: (budgets: MapBudgets) => void;
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
			/>
		</MapInteractionProvider>
	);
};

/**
 * A presentation-safe Map adapter. It reads a pre-sanitized projection and
 * never mounts host hooks for generation, fact checking, selection titles or
 * transcript links. The renderer is unmounted while hidden so its simulation
 * and worker stop doing background work.
 */
export const AudienceMapAdapter = ({
	active,
	endpoint,
	revision = 0,
	waitingLabel,
}: AudienceMapAdapterProps) => {
	const baseRequestKey = `${endpoint}:${revision}`;
	const [admission, setAdmission] = useState<{
		baseRequestKey: string;
		budgets: MapBudgets;
	} | null>(null);
	const activeAdmission =
		admission?.baseRequestKey === baseRequestKey ? admission.budgets : null;
	const requestEndpoint = useMemo(() => {
		if (!activeAdmission) return endpoint;
		const url = new URL(endpoint, globalThis.location.origin);
		url.searchParams.set("node_limit", String(activeAdmission.nodeLimit));
		url.searchParams.set("edge_limit", String(activeAdmission.edgeLimit));
		return url.toString();
	}, [activeAdmission, endpoint]);
	const requestKey = `${baseRequestKey}:${activeAdmission?.nodeLimit ?? "default"}:${activeAdmission?.edgeLimit ?? "default"}`;
	const [result, setResult] = useState<{
		requestKey: string;
		error: string | null;
		payload: AudienceMapResponse | null;
	} | null>(null);
	const current = result?.requestKey === requestKey ? result : null;
	const payload = current?.payload ?? null;
	const error = current?.error ?? null;

	useEffect(() => {
		if (!active || payload) return;
		const controller = new AbortController();
		fetch(requestEndpoint, {
			credentials: "include",
			headers: { Accept: "application/json" },
			signal: controller.signal,
		})
			.then(async (response) => {
				if (response.status === 404) throw new Error("not-ready");
				if (!response.ok)
					throw new Error(`Map request failed (${response.status})`);
				return (await response.json()) as AudienceMapResponse;
			})
			.then((next) => setResult({ error: null, payload: next, requestKey }))
			.catch((reason: unknown) => {
				if (controller.signal.aborted) return;
				setResult({
					error: reason instanceof Error ? reason.message : String(reason),
					payload: null,
					requestKey,
				});
			});
		return () => controller.abort();
	}, [active, payload, requestEndpoint, requestKey]);

	if (!active) return null;
	if (error) {
		if (error === "not-ready") {
			return (
				<div className="flex h-full items-center justify-center p-6">
					<Text size="lg" ta="center" maw={560}>
						{waitingLabel ?? <Trans>Map results are not ready yet.</Trans>}
					</Text>
				</div>
			);
		}
		return (
			<div className="flex h-full items-center justify-center p-6" role="alert">
				<Stack gap="xs" align="center">
					<Text size="lg">
						<Trans>The map could not be loaded.</Trans>
					</Text>
				</Stack>
			</div>
		);
	}
	if (!payload) {
		return (
			<div className="relative h-full" aria-live="polite">
				<DembraneLoadingSpinner isLoading showMessage={false} />
			</div>
		);
	}
	return (
		<AudienceMap
			payload={payload}
			onAdmit={(budgets) => setAdmission({ baseRequestKey, budgets })}
		/>
	);
};
