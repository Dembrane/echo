import { Plural, Trans } from "@lingui/react/macro";
import { Group, Stack, Text } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DembraneLoadingSpinner from "@/components/common/DembraneLoadingSpinner";
import {
	budgetsToAdmit,
	LEGACY_BUDGET_BOUNDS,
	type MapBudgets,
	maximumAdmittedNodes,
} from "@/components/map/budgets";
import { buildMapGraph } from "@/components/map/data/adapter";
import type { FactCheckStates, MapGraphResponse } from "@/components/map/hooks";
import {
	MAP_LIGHT_VARS,
	MapExperience,
	MapSurface,
} from "@/components/map/MapExperience";
import { OverBudgetState } from "@/components/map/panels/BudgetStates";
import {
	type MapSettingsControl,
	MapSettingsMenu,
} from "@/components/map/panels/MapSettingsMenu";
import {
	createMapInteractionStore,
	MapInteractionProvider,
} from "@/components/map/state/interactionStore";
import {
	DEFAULT_MAP_SETTINGS,
	type MapSettings,
} from "@/components/map/state/settings";
import type {
	ColorBy,
	FactCheckState,
	FactCheckVerdict,
} from "@/components/map/types";

type AudienceMapAdapterProps = {
	active: boolean;
	endpoint: string;
	revision?: number;
	waitingLabel?: string;
	/**
	 * The room's theme, the one its own switch is set to. "light" is the host's
	 * Map page exactly, so the default changes nothing.
	 */
	theme?: "light" | "dark";
	/**
	 * Whether the viewer is signed in. Only then may a settled highlight be
	 * titled: that request runs a model behind the host's session, and a
	 * public link has no session to send. Off, no such request is made.
	 */
	titles?: boolean;
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

const EMPTY_STATES: FactCheckStates = {};

/** The room never starts, refreshes or cancels a factual check. */
const noFactCheck = () => {};

/**
 * The room's dark switch is the shell's, the budget is the server's, and the
 * projection carries no relations to draw.
 */
const ROOM_HIDDEN_CONTROLS: MapSettingsControl[] = [
	"darkMode",
	"showRelationships",
];
const ROOM_HIDDEN_CONTROLS_WITHOUT_TITLES: MapSettingsControl[] = [
	...ROOM_HIDDEN_CONTROLS,
	"showExplore",
];

const AudienceMap = ({
	payload,
	onAdmit,
	settings,
	onSettingsChange,
	dark,
	titles,
}: {
	payload: MapGraphResponse;
	onAdmit: (budgets: MapBudgets) => void;
	settings: MapSettings;
	onSettingsChange: (patch: Partial<MapSettings>) => void;
	dark: boolean;
	titles: boolean;
}) => {
	const graph = useMemo(() => buildMapGraph(payload), [payload]);
	// Audience projections expose an existing display classification, never
	// the capability to start or refresh a factual check.
	const factCheckStates = useMemo(() => {
		const assessments = (payload as AudienceMapResponse).fact_checks ?? {};
		const states: FactCheckStates = {};
		for (const node of graph.placedNodes) {
			const assessment = readAssessment(assessments[node.id]);
			if (assessment) states[node.id] = assessment;
		}
		return Object.keys(states).length > 0 ? states : EMPTY_STATES;
	}, [graph.placedNodes, payload]);
	const nodes = useMemo(
		() =>
			graph.placedNodes.map((node) => ({
				...node,
				metadata: {
					...node.metadata,
					// The projection withholds eligibility. An assessed node shows
					// its verdict; any other follows its own kind, so an unchecked
					// claim reads as unverified and never as an opinion.
					factCheckEligible: factCheckStates[node.id] ? true : undefined,
				},
			})),
		[factCheckStates, graph.placedNodes],
	);
	const visibleIds = useMemo(
		() => new Set(graph.allNodes.map((node) => node.id)),
		[graph.allNodes],
	);
	// The same nodes the panels look up, with the room's eligibility.
	const roomGraph = useMemo(() => {
		const byId = new Map(nodes.map((node) => [node.id, node] as const));
		return {
			...graph,
			allNodes: graph.allNodes.map((node) => byId.get(node.id) ?? node),
			placedNodes: nodes,
		};
	}, [graph, nodes]);
	const budgets =
		graph.serverBudgets ??
		graph.budgetBounds?.defaults ??
		LEGACY_BUDGET_BOUNDS.defaults;
	const [store] = useState(() =>
		createMapInteractionStore({ selectedNodeId: nodes[0]?.id ?? null }),
	);
	useEffect(() => {
		const selected = store.getState().selectedNodeId;
		if (selected && nodes.some((node) => node.id === selected)) return;
		store.setSelectedNodeId(nodes[0]?.id ?? null);
	}, [nodes, store]);
	const roomSettings = useMemo(
		() => ({ ...settings, darkMode: dark, showRelationships: false }),
		[dark, settings],
	);
	const handleColorByChange = useCallback(
		(colorBy: ColorBy) => onSettingsChange({ colorBy }),
		[onSettingsChange],
	);

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
		<div
			className="flex h-full min-h-0 flex-col"
			// Dark is relit on the themed root; light is the host page's own.
			style={dark ? undefined : MAP_LIGHT_VARS}
		>
			<Group justify="space-between" gap="xs" wrap="nowrap" px="sm" pt="xs">
				<Text size="sm">
					<Plural value={nodes.length} one="# argument" other="# arguments" />
				</Text>
				<MapSettingsMenu
					settings={roomSettings}
					onChange={onSettingsChange}
					colorBy={settings.colorBy}
					onColorByChange={handleColorByChange}
					canFactCheck={false}
					hide={
						titles ? ROOM_HIDDEN_CONTROLS : ROOM_HIDDEN_CONTROLS_WITHOUT_TITLES
					}
					withinPortal={false}
				/>
			</Group>
			<MapSurface darkMode={false}>
				<MapInteractionProvider store={store}>
					<MapExperience
						graph={roomGraph}
						placedNodes={nodes}
						visibleIds={visibleIds}
						budgets={budgets}
						colorBy={settings.colorBy}
						onColorByChange={handleColorByChange}
						settings={roomSettings}
						factCheckStates={factCheckStates}
						onFactCheck={noFactCheck}
						onCancelFactCheck={noFactCheck}
						canFactCheck={false}
						offline={false}
						titles={titles}
						// The projection strips provenance along with the quotes.
						provenance={false}
					/>
				</MapInteractionProvider>
			</MapSurface>
		</div>
	);
};

/**
 * A presentation-safe Map adapter. It draws the host page's own maps and
 * panels over a pre-sanitized projection: no quotes, no links back into the
 * workspace, and never the host hooks for generation or fact checking.
 * Selection titles are the one host request, and only for a signed-in viewer.
 * The renderer is unmounted while hidden so its simulation, its worker and
 * the Showcase's walk stop doing background work.
 */
export const AudienceMapAdapter = ({
	active,
	endpoint,
	revision = 0,
	waitingLabel,
	theme = "light",
	titles = false,
}: AudienceMapAdapterProps) => {
	const dark = theme === "dark";
	const queryClient = useQueryClient();
	const [admission, setAdmission] = useState<{
		endpoint: string;
		budgets: MapBudgets;
	} | null>(null);
	// Above the hidden boundary: the graph unmounts while another block is on
	// the wall, and the room comes back to the panels and the Showcase the host
	// left running. Kept in memory only: rooms share an origin with each other
	// and with the host's own saved Map settings.
	const [settings, setSettings] = useState<MapSettings>(DEFAULT_MAP_SETTINGS);
	const updateSettings = useCallback(
		(patch: Partial<MapSettings>) =>
			setSettings((current) => ({ ...current, ...patch })),
		[],
	);
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
				settings={settings}
				onSettingsChange={updateSettings}
				dark={dark}
				titles={titles}
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
