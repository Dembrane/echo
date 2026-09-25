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
import { AudienceMapAdapter } from "./AudienceMapAdapter";

const geometryDisposed = vi.hoisted(() => vi.fn());
const walkStep = vi.hoisted(() => vi.fn());

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
		allNodes: [node(1, "A result"), node(2, "A later result")],
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
		]),
		overBudget: false,
		placedNodes: [node(1, "A result"), node(2, "A later result")],
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

vi.mock("@/components/map/renderers/LocalMapGraph", () => ({
	LocalMap: ({ darkMode }: { darkMode?: boolean }) => (
		<div data-dark={darkMode ? "true" : "false"}>Audience local renderer</div>
	),
}));

i18n.load("en-US", {});
i18n.activate("en-US");

afterEach(() => {
	cleanup();
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
		await screen.findByText("Audience tree renderer");
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
		expect(screen.getByText("Audience tree renderer")).toBeTruthy();
		expect(screen.queryByText("The map could not be loaded.")).toBeNull();
	});

	it("disposes the geometry worker boundary when Map is hidden", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
		);
		const view = render(adapter(true));
		await screen.findByText("Audience tree renderer");
		expect(screen.getByText("Audience local renderer")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Panel settings" }));
		fireEvent.click(await screen.findByRole("checkbox", { name: "Clusters" }));
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
	 * Opens the display controls and hands back the Showcase toggle, so a test
	 * can switch the walk on once its timers are the fake ones.
	 */
	const showcaseToggle = async () => {
		fireEvent.click(screen.getByRole("button", { name: "Panel settings" }));
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
		await screen.findByText("Audience tree renderer");
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
		await screen.findByText("Audience tree renderer");
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
		await screen.findByText("Audience tree renderer");
		expect(screen.queryByRole("region", { name: "Explore" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Panel settings" }));
		await screen.findByRole("checkbox", { name: "Showcase" });
		expect(screen.queryByRole("checkbox", { name: "Explore" })).toBeNull();
		// The room's switch and the server's budget are not this menu's.
		expect(screen.queryByRole("checkbox", { name: "Dark mode" })).toBeNull();
		expect(screen.queryByText("Map budget")).toBeNull();
		expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/audience/map"]);
	});

	it("gives a signed-in viewer the host page's Explore panel", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
		);

		render(adapter(true, 0, undefined, true));
		await screen.findByText("Audience tree renderer");
		expect(screen.getByRole("region", { name: "Explore" })).toBeTruthy();
	});

	it("shows the evidence behind a finding, attributed and linking nowhere", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
		);

		render(adapter(true));
		await screen.findByText("Audience tree renderer");
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
		const tree = await screen.findByText("Audience tree renderer");
		const root = screen.getByTestId("audience-map-root");
		expect(root.getAttribute("data-theme")).toBeNull();
		expect(root.style.getPropertyValue("--map-surface")).toBe("");
		expect(tree.getAttribute("data-dark")).toBe("false");
		expect(
			screen.getByText("Audience local renderer").getAttribute("data-dark"),
		).toBe("false");
	});

	it("relights the Map's own variables when the room is dark", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
		);

		render(adapter(true, 0, "dark"));
		const tree = await screen.findByText("Audience tree renderer");
		const root = screen.getByTestId("audience-map-root");
		expect(root.getAttribute("data-theme")).toBe("dark");
		expect(root.style.getPropertyValue("--map-text")).toBe("#F6F4F1");
		expect(root.style.getPropertyValue("--map-surface")).toBe("#1B1B1A");
		// Mantine's panels in this app follow the two app variables, so the
		// panels, the detail card and the waiting line come with them.
		expect(root.style.getPropertyValue("--app-background")).toBe("#262625");
		expect(tree.getAttribute("data-dark")).toBe("true");
		expect(
			screen.getByText("Audience local renderer").getAttribute("data-dark"),
		).toBe("true");
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
