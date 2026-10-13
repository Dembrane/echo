// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMIT_FLASH_MS, DWELL_MS } from "@/components/map/hooks/useMapGroups";
import type { MapInteractionStore } from "@/components/map/state/interactionStore";
import {
	MAP_SETTINGS_STORAGE_KEY,
	MAP_SETTINGS_VERSION,
} from "@/components/map/state/settings";
import { AudienceMapAdapter } from "./AudienceMapAdapter";

const geometryDisposed = vi.hoisted(() => vi.fn());
const walkStep = vi.hoisted(() => vi.fn());
/** The room's interaction store, as the cluster map renderer holds it. */
const roomStore = vi.hoisted(() => ({
	current: null as MapInteractionStore | null,
}));

const node = (index: number, label: string) => ({
	embedding: [0, index],
	id: `revision-${index}`,
	label,
	metadata: {
		objectId: `object-${index}`,
		objectType: "argument",
		revisionId: `revision-${index}`,
		sizeScale: 1,
	},
});

const mapObject = (index: number, statement: string) => ({
	detail: { statement, type: "argument" },
	factCheck: { claimKey: null, eligible: false },
	objectId: `object-${index}`,
	provenance: {
		legacy: false,
		origin: "imported",
		recipeId: null,
		recipeVersion: null,
		runId: null,
	},
	revisionId: `revision-${index}`,
	type: "argument",
});

vi.mock("@/components/map/data/adapter", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/map/data/adapter")>()),
	buildMapGraph: () => ({
		allNodes: [
			node(1, "A result"),
			node(2, "A later result"),
			node(3, "A third result"),
		],
		budgetBounds: null,
		conversationNames: new Map([[1, "Ada"]]),
		counts: { argument: 2 },
		// The room's projection now carries the evidence behind a finding,
		// under the palette slot it was spoken in.
		evidenceById: new Map([
			[
				"revision-1",
				[
					{
						conversationId: "slot:1",
						label: "Ada",
						quotes: ["The bins are always full."],
						slot: 1,
					},
				],
			],
		]),
		objectsById: new Map([
			["revision-1", mapObject(1, "A result")],
			["revision-2", mapObject(2, "A later result")],
			["revision-3", mapObject(3, "A third result")],
		]),
		overBudget: false,
		placedNodes: [
			node(1, "A result"),
			node(2, "A later result"),
			node(3, "A third result"),
		],
		relatedStubs: new Map(),
		relations: [],
		resultId: "snapshot-1",
		serverBudgets: { edgeLimit: 10, nodeLimit: 10 },
		snapshotId: "snapshot-1",
	}),
}));

vi.mock("@/components/map/layout/useMapGeometry", async () => {
	const React = await import("react");
	return {
		EMPTY_EDGES: [],
		useMapGeometry: () => {
			React.useEffect(() => () => geometryDisposed(), []);
			return {
				mstEdges: [],
				neighbours: { fpLinks: [], nnLinks: [] },
				status: "ready",
			};
		},
	};
});

const WALK_INTERVAL_MS = 30_000;

// Stands in for the renderer's random walk: it reports the node it stands on
// and when it moves on, and runs no timer while `autoAdvance` is off.
vi.mock("@/components/map/renderers/MstGraph", async () => {
	const React = await import("react");
	return {
		DEFAULT_WALK_INTERVAL_MS: 30_000,
		MstMap: ({
			nodes,
			autoAdvance,
			darkMode,
			onActiveNodeChange,
		}: {
			nodes: { id: string }[];
			autoAdvance?: boolean;
			darkMode?: boolean;
			onActiveNodeChange?: (
				node: { id: string } | null,
				expiresAt: number | null,
				durationMs: number,
			) => void;
		}) => {
			React.useEffect(() => {
				if (!autoAdvance || !onActiveNodeChange || nodes.length === 0) return;
				let step = 0;
				let timer = 0;
				const advance = () => {
					walkStep();
					onActiveNodeChange(
						nodes[step % nodes.length],
						Date.now() + 30_000,
						30_000,
					);
					step += 1;
					timer = window.setTimeout(advance, 30_000);
				};
				advance();
				return () => window.clearTimeout(timer);
			}, [autoAdvance, nodes, onActiveNodeChange]);
			return (
				<div data-dark={darkMode ? "true" : "false"}>
					Audience tree renderer
				</div>
			);
		},
	};
});

// Stands in for the cluster map: it says which nodes are highlighted and
// whether the dwell circle runs, and hands the test the room's store.
vi.mock("@/components/map/renderers/LocalMapGraph", async () => {
	const { useMapInteraction, useMapInteractionStore } = await import(
		"@/components/map/state/interactionStore"
	);
	return {
		LocalMap: ({
			darkMode,
			density,
			showForceSettings,
			timerActive,
		}: {
			darkMode?: boolean;
			density?: number;
			showForceSettings?: boolean;
			timerActive?: boolean;
		}) => {
			roomStore.current = useMapInteractionStore();
			const highlighted = useMapInteraction(
				(state) => state.highlightedNodeIds,
			);
			return (
				<div
					data-dark={darkMode ? "true" : "false"}
					data-density={density}
					data-forces={showForceSettings ? "true" : "false"}
					data-highlighted={[...highlighted].sort().join(",")}
					data-testid="local-map"
					data-timer={timerActive ? "true" : "false"}
				>
					Audience local renderer
				</div>
			);
		},
	};
});

i18n.load("en-US", {});
i18n.activate("en-US");

afterEach(() => {
	cleanup();
	roomStore.current = null;
	globalThis.localStorage?.removeItem(MAP_SETTINGS_STORAGE_KEY);
	geometryDisposed.mockClear();
	walkStep.mockClear();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

beforeEach(() => {
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	vi.stubGlobal(
		"matchMedia",
		vi.fn(() => ({
			addEventListener: vi.fn(),
			matches: false,
			removeEventListener: vi.fn(),
		})),
	);
});

describe("AudienceMapAdapter", () => {
	let client: QueryClient;

	beforeEach(() => {
		client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	});

	afterEach(() => {
		client.clear();
	});

	const adapter = (
		active: boolean,
		revision = 0,
		theme?: "light" | "dark",
		titles?: boolean,
	) => (
		<QueryClientProvider client={client}>
			<I18nProvider i18n={i18n}>
				<MantineProvider>
					<AudienceMapAdapter
						active={active}
						endpoint="/audience/map"
						revision={revision}
						theme={theme}
						titles={titles}
					/>
				</MantineProvider>
			</I18nProvider>
		</QueryClientProvider>
	);

	it("does not request host capabilities while hidden and aborts an in-flight read", async () => {
		let signal: AbortSignal | undefined;
		const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
			signal = init?.signal ?? undefined;
			return new Promise<Response>(() => {});
		});
		vi.stubGlobal("fetch", fetchMock);

		const view = render(adapter(false));
		expect(fetchMock).not.toHaveBeenCalled();

		view.rerender(adapter(true));
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		expect(fetchMock).toHaveBeenCalledWith(
			"/audience/map",
			expect.objectContaining({ credentials: "include" }),
		);

		view.rerender(adapter(false));
		expect(signal?.aborted).toBe(true);
	});

	it("reads nothing while the Map tab is hidden, however many audience events arrive", async () => {
		const fetchMock = vi.fn(
			async () => new Response(JSON.stringify({}), { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const view = render(adapter(true, 1));
		await screen.findByText("Audience local renderer");
		expect(fetchMock).toHaveBeenCalledTimes(1);

		view.rerender(adapter(false, 2));
		view.rerender(adapter(false, 3));
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// The events that arrived while hidden are read once, on the way back.
		view.rerender(adapter(true, 3));
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
	});

	it("keeps the graph on screen when a refetch fails", async () => {
		let failNext = false;
		const fetchMock = vi.fn(async () =>
			failNext
				? new Response("", { status: 503 })
				: new Response(JSON.stringify({}), { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const view = render(adapter(true, 1));
		// The label reads in the Spotlight and again in the list under the map.
		expect((await screen.findAllByText("A result")).length).toBeGreaterThan(0);

		failNext = true;
		view.rerender(adapter(true, 2));
		await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

		expect(screen.getAllByText("A result").length).toBeGreaterThan(0);
		expect(screen.getByText("Audience local renderer")).toBeTruthy();
		expect(screen.queryByText("The map could not be loaded.")).toBeNull();
	});

	it("disposes the geometry worker boundary when Map is hidden", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
		);
		const view = render(adapter(true));
		// Clusters first, as on the host's Map page.
		await screen.findByText("Audience local renderer");
		expect(screen.queryByText("Audience tree renderer")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Argument tree" }));
		expect(screen.queryByText("Audience local renderer")).toBeNull();
		expect(screen.getByText("Audience tree renderer")).toBeTruthy();

		view.rerender(adapter(false));
		expect(geometryDisposed).toHaveBeenCalledTimes(1);
	});

	it("shows sanitized existing assessments without calling host or model endpoints", async () => {
		const fetchMock = vi.fn(
			async (_url: string, _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						fact_checks: {
							"revision-1": {
								checkedAt: "2026-09-18T00:00:00Z",
								justification: "Supported by the prepared evidence.",
								status: "done",
								verdict: "true",
							},
						},
					}),
					{ status: 200 },
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		render(adapter(true));

		expect((await screen.findAllByText("A result")).length).toBeGreaterThan(0);
		// As on the host's page, the verdict chip colours the map by factual
		// status and opens the justification that came with the payload.
		fireEvent.click(screen.getByRole("button", { name: "Likely true" }));
		expect(
			screen.getByText("Supported by the prepared evidence."),
		).toBeTruthy();
		// The room reads verdicts; it never starts, repeats or cancels a check.
		expect(screen.queryByRole("button", { name: "Re-check" })).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe("/audience/map");
	});

	/**
	 * Puts the tree up from the rail (the walk lives on it, as on the host's
	 * page), opens the settings and hands back the Showcase toggle, so a test
	 * can switch the walk on once its timers are the fake ones.
	 */
	const showcaseToggle = async () => {
		fireEvent.click(screen.getByRole("button", { name: "Argument tree" }));
		await screen.findByText("Audience tree renderer");
		fireEvent.click(screen.getByRole("button", { name: "Settings" }));
		return await screen.findByRole("checkbox", { name: "Showcase" });
	};

	const showcasePanel = () => screen.getByRole("region", { name: "Showcase" });

	it("walks the map in the Showcase, reading the payload and nothing else", async () => {
		const fetchMock = vi.fn(
			async (_url: string, _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						fact_checks: {
							"revision-1": {
								checkedAt: "2026-09-18T00:00:00Z",
								justification: "Supported by the prepared evidence.",
								status: "done",
								verdict: "true",
							},
						},
					}),
					{ status: 200 },
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		render(adapter(true));
		await screen.findByText("Audience local renderer");
		expect(screen.queryByRole("region", { name: "Showcase" })).toBeNull();

		const toggle = await showcaseToggle();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		fireEvent.click(toggle);
		expect(within(showcasePanel()).getByText("A result")).toBeTruthy();
		// The verdict on the wall is the assessment that came with the payload.
		expect(within(showcasePanel()).getByText("Likely true")).toBeTruthy();

		act(() => {
			vi.advanceTimersByTime(WALK_INTERVAL_MS);
		});
		expect(within(showcasePanel()).getByText("A later result")).toBeTruthy();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/audience/map"]);
	});

	it("stops the walk while the Map is hidden and picks it up again", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
		);

		const view = render(adapter(true));
		await screen.findByText("Audience local renderer");
		const toggle = await showcaseToggle();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		fireEvent.click(toggle);
		expect(walkStep).toHaveBeenCalledTimes(1);

		act(() => {
			vi.advanceTimersByTime(WALK_INTERVAL_MS);
		});
		expect(walkStep).toHaveBeenCalledTimes(2);

		view.rerender(adapter(false));
		expect(screen.queryByRole("region", { name: "Showcase" })).toBeNull();
		act(() => {
			vi.advanceTimersByTime(WALK_INTERVAL_MS * 4);
		});
		expect(walkStep).toHaveBeenCalledTimes(2);

		// Back on the wall: the Showcase the host left on runs again.
		view.rerender(adapter(true));
		expect(walkStep).toHaveBeenCalledTimes(3);
		expect(within(showcasePanel()).getByText("A result")).toBeTruthy();
	});

	it("offers no model-written titles to a viewer who is not signed in", async () => {
		const fetchMock = vi.fn(
			async (_url: string, _init?: RequestInit) =>
				new Response(JSON.stringify({}), { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);

		render(adapter(true));
		await screen.findByText("Audience local renderer");
		// No distilling for a public room: only clicked arguments are kept.
		expect(
			await screen.findByText("The arguments you click are kept here."),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Settings" }));
		await screen.findByRole("checkbox", { name: "Showcase" });
		expect(screen.queryByRole("checkbox", { name: "History" })).toBeNull();
		// The room's switch, the server's budget and the host's forces are not
		// this menu's.
		expect(screen.queryByRole("checkbox", { name: "Dark mode" })).toBeNull();
		expect(screen.queryByText("Map budget")).toBeNull();
		expect(
			screen.queryByRole("checkbox", { name: "Force settings" }),
		).toBeNull();
		expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/audience/map"]);
	});

	it("never offers a signed-in room the dwell that makes a group", async () => {
		const fetchMock = vi.fn(
			async (_url: string, _init?: RequestInit) =>
				new Response(JSON.stringify({}), { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);

		render(adapter(true, 0, undefined, true));
		await screen.findByText("Audience local renderer");
		expect(
			await screen.findByText("The arguments you click are kept here."),
		).toBeTruthy();
		expect(screen.queryByText(/rest the cursor on a cluster/)).toBeNull();
		// The groups come with the map: the room asks the host's list for none.
		expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/audience/map"]);
	});

	const groupsPayload = {
		groups: [
			{
				createdAt: "2026-10-06T10:02:00+00:00",
				error: null,
				id: "group-titled",
				members: [1, 2, 3].map((index) => ({
					objectId: `object-${index}`,
					revisionId: `revision-${index}`,
					type: "argument",
				})),
				snapshotId: "snapshot-1",
				status: "ready",
				title: "Bins and buses",
			},
			{
				createdAt: "2026-10-06T10:01:00+00:00",
				error: null,
				id: "group-pending",
				members: [1, 2].map((index) => ({
					objectId: `object-${index}`,
					revisionId: `revision-${index}`,
					type: "argument",
				})),
				snapshotId: "snapshot-1",
				status: "pending",
				title: null,
			},
			{
				createdAt: "2026-10-06T10:00:00+00:00",
				error: null,
				id: "group-failed",
				members: [2, 3].map((index) => ({
					objectId: `object-${index}`,
					revisionId: `revision-${index}`,
					type: "argument",
				})),
				snapshotId: "snapshot-1",
				status: "failed",
				title: null,
			},
		],
	};

	it("shows the project's groups in History, read-only", async () => {
		const fetchMock = vi.fn(
			async (_url: string, _init?: RequestInit) =>
				new Response(JSON.stringify(groupsPayload), { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);

		render(adapter(true));
		expect(await screen.findByText("Bins and buses")).toBeTruthy();
		expect(screen.getByText("Distilling core idea…")).toBeTruthy();
		expect(screen.getByText("The title could not be generated.")).toBeTruthy();
		expect(screen.getAllByTestId("history-cluster")).toHaveLength(3);
		// A failed group offers no retry on the room.
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
		expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/audience/map"]);
	});

	it("shows a pending group's title once an audience event re-reads the map", async () => {
		const pending = groupsPayload.groups[1];
		let landed = false;
		const fetchMock = vi.fn(
			async (_url: string, _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						groups: [
							landed
								? { ...pending, status: "ready", title: "Ferry timetables" }
								: pending,
						],
					}),
					{ status: 200 },
				),
		);
		vi.stubGlobal("fetch", fetchMock);

		const view = render(adapter(true, 0));
		expect(await screen.findByText("Distilling core idea…")).toBeTruthy();

		// The title lands; the group's event reaches the room as an audience event.
		landed = true;
		view.rerender(adapter(true, 1));
		expect(await screen.findByText("Ferry timetables")).toBeTruthy();
		expect(screen.queryByText("Distilling core idea…")).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("highlights a group's members when it is picked, and shows it in Spotlight", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify(groupsPayload), { status: 200 }),
			),
		);

		render(adapter(true));
		const row = (await screen.findByText("Bins and buses")).closest("button");
		expect(row).toBeTruthy();
		expect(screen.getByTestId("local-map").dataset.highlighted).toBe("");
		fireEvent.click(row as HTMLElement);
		expect(screen.getByTestId("local-map").dataset.highlighted).toBe(
			"revision-1,revision-2,revision-3",
		);
		// Spotlight leads with the group; History keeps the other two.
		expect(screen.getAllByText("Bins and buses").length).toBeGreaterThan(0);
		expect(screen.getAllByTestId("history-cluster")).toHaveLength(2);
	});

	it("commits nothing when the cursor rests on a cluster", async () => {
		const fetchMock = vi.fn(
			async (_url: string, _init?: RequestInit) =>
				new Response(JSON.stringify({}), { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);

		render(adapter(true, 0, undefined, true));
		await screen.findByText("Audience local renderer");
		const store = roomStore.current;
		expect(store).toBeTruthy();

		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		act(() => {
			store?.setHighlightedNodeIds(
				new Set(["revision-1", "revision-2", "revision-3"]),
				{ isPreview: false, source: "local-hover" },
			);
		});
		expect(screen.getByTestId("local-map").dataset.timer).toBe("false");
		act(() => {
			vi.advanceTimersByTime(DWELL_MS + COMMIT_FLASH_MS);
		});
		expect(screen.getByTestId("local-map").dataset.timer).toBe("false");
		expect(screen.queryByText("Distilling core idea…")).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[1]?.method).toBeUndefined();
	});

	it("shows the evidence behind a finding, attributed and linking nowhere", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
		);

		render(adapter(true));
		await screen.findByText("Audience local renderer");
		expect(
			(await screen.findAllByText("The bins are always full.")).length,
		).toBeGreaterThan(0);
		// The conversation is named because the presentation said it may be.
		expect(screen.getAllByText("Ada").length).toBeGreaterThan(0);
		// Nothing on the room's surface opens a conversation.
		expect(screen.queryByRole("link")).toBeNull();
	});

	it("leaves the Map exactly as the host page has it by default", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
		);

		render(adapter(true));
		const clusters = await screen.findByText("Audience local renderer");
		const root = screen.getByTestId("audience-map-root");
		expect(root.getAttribute("data-theme")).toBeNull();
		expect(root.style.getPropertyValue("--map-surface")).toBe("");
		expect(clusters.getAttribute("data-dark")).toBe("false");
		// Clusters first, as the host's Map page opens.
		expect(screen.queryByText("Audience tree renderer")).toBeNull();
	});

	it("draws the clusters at the density the host saved, with Spotlight and without the force panels", async () => {
		globalThis.localStorage.setItem(
			MAP_SETTINGS_STORAGE_KEY,
			JSON.stringify({
				clusterDensity: 4,
				showForceSettings: true,
				showSpotlight: false,
				version: MAP_SETTINGS_VERSION,
			}),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
		);

		render(adapter(true));
		await screen.findByText("Audience local renderer");
		const clusters = screen.getByTestId("local-map");
		expect(clusters.dataset.density).toBe("4");
		expect(clusters.dataset.forces).toBe("false");
		// History lives in Spotlight, so the room opens with it.
		expect(
			await screen.findByText("The arguments you click are kept here."),
		).toBeTruthy();
		// No editing toolbar: only the density dial, for this screen alone.
		expect(screen.queryByLabelText("Map controls")).toBeNull();
		expect(screen.getAllByRole("slider")).toHaveLength(1);
	});

	it("holds the dial, clusters or tree and the settings in a rail beside the map", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
		);
		render(adapter(true));
		await screen.findByText("Audience local renderer");
		const rail = screen.getByRole("group", { name: "Map display" });
		const controls = [
			within(rail).getByRole("slider", {
				name: "Cluster density: fewer or more clusters",
			}),
			within(rail).getByRole("button", { name: "Cluster map" }),
			within(rail).getByRole("button", { name: "Argument tree" }),
			within(rail).getByRole("button", { name: "Settings" }),
		];
		// Top to bottom, in that order, and the dial stands upright.
		for (let index = 1; index < controls.length; index += 1) {
			expect(
				controls[index - 1].compareDocumentPosition(controls[index]) &
					Node.DOCUMENT_POSITION_FOLLOWING,
			).toBeTruthy();
		}
		expect(controls[0].getAttribute("aria-orientation")).toBe("vertical");
		// The rail sits after the map, so it lands on the map's right.
		expect(
			screen.getByTestId("local-map").compareDocumentPosition(rail) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();

		// Clusters first; the tree takes over from the rail.
		const clusters = within(rail).getByRole("button", { name: "Cluster map" });
		const tree = within(rail).getByRole("button", { name: "Argument tree" });
		expect(clusters.getAttribute("aria-pressed")).toBe("true");
		expect(tree.getAttribute("aria-pressed")).toBe("false");
		fireEvent.click(tree);
		expect(await screen.findByText("Audience tree renderer")).toBeTruthy();
		expect(tree.getAttribute("aria-pressed")).toBe("true");
		fireEvent.click(clusters);
		expect(await screen.findByText("Audience local renderer")).toBeTruthy();
	});

	it("keeps the count out of the room's view and in the settings heading", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
		);
		render(adapter(true));
		await screen.findByText("Audience local renderer");
		expect(screen.queryByText("3 arguments")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Settings" }));
		await screen.findByRole("checkbox", { name: "Showcase" });
		expect(screen.getByText("3 arguments")).toBeTruthy();
		// Clusters or tree is the rail's, so the menu does not offer it twice.
		expect(screen.queryByRole("radio", { name: "Tree" })).toBeNull();
		// Colour stays in the menu.
		expect(screen.getByText("Color nodes by")).toBeTruthy();
	});

	it("lets the room change its own density with the dial's keys", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
		);
		render(adapter(true));
		await screen.findByText("Audience local renderer");
		const density = () =>
			Number(screen.getByTestId("local-map").dataset.density);
		const before = density();
		const dial = screen.getByRole("slider");
		dial.focus();
		fireEvent.keyDown(dial, { key: "ArrowUp" });
		await waitFor(() => expect(density()).toBeGreaterThan(before));
		const raised = density();
		fireEvent.keyDown(dial, { key: "ArrowDown" });
		fireEvent.keyDown(dial, { key: "ArrowDown" });
		await waitFor(() => expect(density()).toBeLessThan(raised));
		fireEvent.keyDown(dial, { key: "End" });
		await waitFor(() => expect(density()).toBeCloseTo(16));
		fireEvent.keyDown(dial, { key: "Home" });
		await waitFor(() => expect(density()).toBeCloseTo(0.25));
	});

	it("lays the dial flat in a row under the map at phone width", async () => {
		vi.stubGlobal(
			"matchMedia",
			vi.fn((query: string) => ({
				addEventListener: vi.fn(),
				matches: query.includes("max-width: 639px"),
				removeEventListener: vi.fn(),
			})),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
		);
		render(adapter(true));
		await screen.findByText("Audience local renderer");
		const rail = screen.getByRole("group", { name: "Map display" });
		await waitFor(() =>
			expect(
				within(rail).getByRole("slider").getAttribute("aria-orientation"),
			).not.toBe("vertical"),
		);
		const before = screen.getByTestId("local-map").dataset.density;
		const dial = within(rail).getByRole("slider");
		dial.focus();
		fireEvent.keyDown(dial, { key: "End" });
		await waitFor(() =>
			expect(screen.getByTestId("local-map").dataset.density).not.toBe(before),
		);
	});

	it("relights the Map's own variables when the room is dark", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
		);

		render(adapter(true, 0, "dark"));
		const clusters = await screen.findByText("Audience local renderer");
		const root = screen.getByTestId("audience-map-root");
		expect(root.getAttribute("data-theme")).toBe("dark");
		expect(root.style.getPropertyValue("--map-text")).toBe("#F6F4F1");
		expect(root.style.getPropertyValue("--map-surface")).toBe("#000000");
		// Mantine's panels in this app follow the two app variables, so the
		// panels, the detail card and the waiting line come with them.
		expect(root.style.getPropertyValue("--app-background")).toBe("#161615");
		expect(clusters.getAttribute("data-dark")).toBe("true");
	});

	it("keeps the waiting state inside the themed root", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("", { status: 404 })),
		);

		render(adapter(true, 0, "dark"));
		const waiting = await screen.findByText("Map results are not ready yet.");
		const root = screen.getByTestId("audience-map-root");
		expect(root.contains(waiting)).toBe(true);
		expect(root.getAttribute("data-theme")).toBe("dark");
	});
});
