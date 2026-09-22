// @vitest-environment jsdom
/**
 * The layout benchmark ladder. Skipped unless MAP_BENCH is set:
 *
 *   MAP_BENCH=1 pnpm exec vitest run src/components/map/layout/benchmark.run.test.tsx
 *
 * Prints markdown tables for BENCHMARKS.md: the worker computation (node,
 * no DOM) and, where jsdom allows, renderer mount, force step and tick
 * drawing. jsdom has no layout or paint, so its numbers bound DOM work, not
 * browser frame time.
 */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { act, cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LEGACY_BUDGET_BOUNDS, minEdgeLimit } from "../budgets";
import { nodeGeometryKey } from "../graph/nodeSet";
import { d3, type Simulation, type SimulationNodeDatum } from "../renderers/d3";
import { LocalMap } from "../renderers/LocalMapGraph";
import { MstMap } from "../renderers/MstGraph";
import {
	createMapInteractionStore,
	MapInteractionProvider,
} from "../state/interactionStore";
import {
	type BenchmarkFixture,
	createBenchmarkFixture,
	formatLayoutTable,
	type LayoutMeasurement,
	measureLayout,
	type RelationDensity,
} from "./benchmark";
import { packVectors, runLayoutSync } from "./compute";
import { registerGeometryResult } from "./geometryResult";

vi.mock("../renderers/d3", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../renderers/d3")>();
	return {
		...actual,
		d3: { ...actual.d3, forceSimulation: vi.fn(actual.d3.forceSimulation) },
	};
});

const runtime = globalThis as {
	process?: { env?: Record<string, string | undefined> };
	gc?: () => void;
};
const RUN = Boolean(runtime.process?.env?.MAP_BENCH);

const COUNTS = [150, 300, 500, 1000];
const DENSITIES: RelationDensity[] = ["sparse", "dense"];

i18n.load("en-US", {});
i18n.activate("en-US");

type TickableSimulation = Simulation<SimulationNodeDatum & { id: string }> & {
	tick: (iterations?: number) => void;
	on: (typenames: string) => () => void;
};

const latestSimulation = () =>
	vi.mocked(d3.forceSimulation).mock.results.at(-1)
		?.value as TickableSimulation;

const timed = (run: () => void) => {
	const start = performance.now();
	run();
	return performance.now() - start;
};

type RenderMeasurement = {
	count: number;
	density: RelationDensity;
	mst: { mountMs: number; forceStepMs: number; drawMs: number; lines: number };
	localMap: {
		mountMs: number;
		forceStepMs: number;
		drawMs: number;
		lines: number;
	};
};

const inProviders = (ui: ReactNode) => (
	<MantineProvider>
		<I18nProvider i18n={i18n}>
			<MapInteractionProvider store={createMapInteractionStore()}>
				{ui}
			</MapInteractionProvider>
		</I18nProvider>
	</MantineProvider>
);

/** Mount time, one force step and one tick's drawing, averaged over five. */
function measureRenderer(ui: ReactNode) {
	let mountMs = 0;
	let container: HTMLElement | null = null;
	mountMs = timed(() => {
		act(() => {
			container = render(inProviders(ui)).container;
		});
	});
	const simulation = latestSimulation();
	simulation.stop();
	const draw = simulation.on("tick");
	const forceStepMs = timed(() => simulation.tick(5)) / 5;
	const drawMs =
		timed(() => {
			for (let i = 0; i < 5; i++) draw();
		}) / 5;
	const lines =
		(container as HTMLElement | null)?.querySelectorAll("line").length ?? 0;
	cleanup();
	return { drawMs, forceStepMs, lines, mountMs };
}

function measureRenderers(fixture: BenchmarkFixture): RenderMeasurement {
	const { nodes, relations } = fixture;
	const layout = runLayoutSync({
		...packVectors(nodes),
		nodeLimit: nodes.length,
	});
	const geometry = registerGeometryResult({
		centerId: layout.centerId,
		key: nodeGeometryKey(nodes),
		mstEdges: layout.mstEdges,
		neighbours: layout.neighbours,
	});
	const edgeLimit = Math.max(
		LEGACY_BUDGET_BOUNDS.defaults.edgeLimit,
		minEdgeLimit(nodes.length),
	);
	const mst = measureRenderer(
		<MstMap
			nodes={nodes}
			mstEdges={geometry.mstEdges}
			relations={relations}
			showRelationships
			edgeLimit={edgeLimit}
			autoAdvance={false}
		/>,
	);
	const localMap = measureRenderer(
		<LocalMap
			nodes={nodes}
			mstEdges={geometry.mstEdges}
			neighbours={geometry.neighbours}
			relations={relations}
			showRelationships
			showNeighbourLinks
			edgeLimit={edgeLimit}
		/>,
	);
	return { count: nodes.length, density: fixture.density, localMap, mst };
}

const ms = (value: number) => value.toFixed(1);

function formatRenderTable(rows: ReadonlyArray<RenderMeasurement>): string {
	const header = [
		"| Nodes | Relations | MST mount ms | MST force step ms | MST draw ms | MST lines | LocalMap mount ms | LocalMap force step ms | LocalMap draw ms | LocalMap lines |",
		"|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|",
	];
	return [
		...header,
		...rows.map(
			(row) =>
				`| ${row.count} | ${row.density} | ${ms(row.mst.mountMs)} | ${ms(row.mst.forceStepMs)} | ${ms(row.mst.drawMs)} | ${row.mst.lines} | ${ms(row.localMap.mountMs)} | ${ms(row.localMap.forceStepMs)} | ${ms(row.localMap.drawMs)} | ${row.localMap.lines} |`,
		),
	].join("\n");
}

beforeAll(() => {
	window.matchMedia =
		window.matchMedia ||
		((query: string) => ({
			addEventListener: () => {},
			addListener: () => {},
			dispatchEvent: () => false,
			matches: false,
			media: query,
			onchange: null,
			removeEventListener: () => {},
			removeListener: () => {},
		}));
	window.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof window.ResizeObserver;
});

afterEach(cleanup);

describe.skipIf(!RUN)("map layout benchmark", () => {
	it(
		"measures the ladder at 150, 300, 500 and 1,000 nodes",
		() => {
			// Warm the JIT on a small run first
			measureLayout(createBenchmarkFixture({ count: 60, density: "sparse" }), {
				edgeLimit: LEGACY_BUDGET_BOUNDS.defaults.edgeLimit,
			});

			const layoutRows: LayoutMeasurement[] = [];
			const renderRows: RenderMeasurement[] = [];
			for (const count of COUNTS) {
				for (const density of DENSITIES) {
					const fixture = createBenchmarkFixture({ count, density });
					layoutRows.push(
						measureLayout(fixture, {
							collectGarbage: runtime.gc,
							edgeLimit: Math.max(
								LEGACY_BUDGET_BOUNDS.defaults.edgeLimit,
								minEdgeLimit(count),
							),
						}),
					);
					renderRows.push(measureRenderers(fixture));
				}
			}

			console.log(
				[
					"",
					"## Layout computation",
					"",
					formatLayoutTable(layoutRows),
					"",
					"## Renderers in jsdom",
					"",
					formatRenderTable(renderRows),
					"",
					`gc exposed: ${Boolean(runtime.gc)}`,
				].join("\n"),
			);
			expect(layoutRows).toHaveLength(COUNTS.length * DENSITIES.length);
		},
		30 * 60_000,
	);
});
