/**
 * Benchmark fixtures and measurements for the map layout: synthetic node
 * sets with 768-dimensional vectors and sparse or dense relationships, and
 * the time and memory of each stage measured separately (worker
 * computation, the result's structured clone, main-thread renderer prep,
 * edge selection). Measurements, not defaults: see BENCHMARKS.md.
 */
import { createSyntheticMap } from "../fixtures/syntheticMap";
import { calculateInitialPositions } from "../graph/layout";
import { seededRandom } from "../graph/localMap";
import { buildRootedTree, mstHopDistances } from "../graph/mst";
import type { MapGraphNode, MapRelation } from "../types";
import { type LayoutTimings, packVectors, runLayoutSync } from "./compute";
import {
	type EdgeCounts,
	selectLocalMapEdges,
	selectMstEdges,
} from "./edgeBudget";

export type RelationDensity = "sparse" | "dense";

/** Relations per node: sparse about one, dense eight. */
export const RELATIONS_PER_NODE: Readonly<Record<RelationDensity, number>> = {
	dense: 8,
	sparse: 1,
};

const RELATION_TYPES = [
	"supports_pole_a",
	"supports_pole_b",
	"holds_position",
	"affected_by",
] as const;

/**
 * Deterministic relations: `perNode` from every node to random other nodes.
 * Pairs may repeat with another type, as real tensions and stakeholders do.
 */
export function createRelationFixture(
	ids: ReadonlyArray<string>,
	perNode: number,
	seed = 7,
): MapRelation[] {
	const random = seededRandom(seed);
	const relations: MapRelation[] = [];
	if (ids.length < 2) return relations;
	ids.forEach((source, index) => {
		for (let r = 0; r < perNode; r++) {
			let targetIndex = Math.floor(random() * ids.length);
			if (targetIndex === index) targetIndex = (targetIndex + 1) % ids.length;
			relations.push({
				basis: "extracted",
				id: `relation-${index}-${r}`,
				source,
				target: ids[targetIndex],
				type: RELATION_TYPES[Math.floor(random() * RELATION_TYPES.length)],
			});
		}
	});
	return relations;
}

export type BenchmarkFixture = {
	nodes: MapGraphNode[];
	relations: MapRelation[];
	density: RelationDensity;
	dims: number;
};

export function createBenchmarkFixture({
	count,
	density,
	dims = 768,
	seed = 42,
}: {
	count: number;
	density: RelationDensity;
	dims?: number;
	seed?: number;
}): BenchmarkFixture {
	const nodes = createSyntheticMap({ clusters: 8, count, dims, seed });
	const relations = createRelationFixture(
		nodes.map((node) => node.id),
		RELATIONS_PER_NODE[density],
		seed,
	);
	return { density, dims, nodes, relations };
}

export type LayoutMeasurement = {
	count: number;
	dims: number;
	density: RelationDensity;
	relations: number;
	/** Worker computation, active time per stage. */
	layout: LayoutTimings;
	/** Typed arrays the computation allocates. */
	workingBytes: number;
	/** The packed vectors transferred to the worker. */
	vectorBytes: number;
	/** Heap growth over the computation, where the runtime exposes it. */
	heapDeltaBytes: number | null;
	/** Structured clone of the result (the worker's postMessage). */
	resultCloneMs: number;
	/** Main-thread work a renderer still does with the result. */
	rendererPrepMs: {
		hopDistances: number;
		rootedTree: number;
		initialPositions: number;
	};
	edgeSelectionMs: { mst: number; localMap: number };
	counts: { mst: EdgeCounts; localMap: EdgeCounts };
};

type MemoryReader = () => number;

const heapReader = (): MemoryReader | null => {
	const runtime = (
		globalThis as {
			process?: { memoryUsage?: () => { heapUsed: number } };
		}
	).process;
	const memoryUsage = runtime?.memoryUsage;
	return memoryUsage ? () => memoryUsage().heapUsed : null;
};

const timed = <T>(run: () => T): { value: T; ms: number } => {
	const start = performance.now();
	const value = run();
	return { ms: performance.now() - start, value };
};

/**
 * Measures one fixture at one edge budget. `collectGarbage`, when given,
 * runs before the heap reading so the delta is the computation's own.
 */
export function measureLayout(
	fixture: BenchmarkFixture,
	{
		edgeLimit,
		collectGarbage,
	}: { edgeLimit: number; collectGarbage?: () => void },
): LayoutMeasurement {
	const { nodes, relations } = fixture;
	const readHeap = heapReader();
	const packed = packVectors(nodes);
	const vectorBytes = packed.vectors.byteLength;

	collectGarbage?.();
	const heapBefore = readHeap?.() ?? null;
	const result = runLayoutSync({ ...packed, nodeLimit: nodes.length });
	const heapAfter = readHeap?.() ?? null;

	const clone = timed(() => structuredClone(result));
	const hopDistances = timed(() => mstHopDistances(nodes, result.mstEdges));
	const rootedTree = timed(() =>
		buildRootedTree(nodes, result.mstEdges, result.centerId),
	);
	const initialPositions = timed(() =>
		calculateInitialPositions(
			nodes,
			result.mstEdges,
			800,
			600,
			result.centerId,
		),
	);

	const nodeIds = new Set(nodes.map((node) => node.id));
	const selectedId = nodes[0]?.id ?? null;
	const mst = timed(() =>
		selectMstEdges({
			edgeLimit,
			nodeIds,
			relations,
			selectedId,
			showRelationships: true,
			treeEdges: result.mstEdges,
		}),
	);
	const localMap = timed(() =>
		selectLocalMapEdges({
			edgeLimit,
			neighbourLinks: result.neighbours.nnLinks,
			nodeIds,
			relations,
			selectedId,
			showNeighbourLinks: true,
			showRelationships: true,
		}),
	);

	return {
		count: nodes.length,
		counts: { localMap: localMap.value.counts, mst: mst.value.counts },
		density: fixture.density,
		dims: fixture.dims,
		edgeSelectionMs: { localMap: localMap.ms, mst: mst.ms },
		heapDeltaBytes:
			heapBefore !== null && heapAfter !== null ? heapAfter - heapBefore : null,
		layout: result.timings,
		relations: relations.length,
		rendererPrepMs: {
			hopDistances: hopDistances.ms,
			initialPositions: initialPositions.ms,
			rootedTree: rootedTree.ms,
		},
		resultCloneMs: clone.ms,
		vectorBytes,
		workingBytes: result.workingBytes,
	};
}

const ms = (value: number) => value.toFixed(1);
const mb = (bytes: number | null) =>
	bytes === null ? "n/a" : (bytes / (1024 * 1024)).toFixed(1);

/** Markdown table of layout measurements, one row per fixture. */
export function formatLayoutTable(
	rows: ReadonlyArray<LayoutMeasurement>,
): string {
	const header = [
		"| Nodes | Relations | Distances ms | MST ms | Centre ms | Neighbours ms | Worker total ms | Result clone ms | Working MB | Vectors MB | Heap delta MB | Hop distances ms | Rooted tree ms | Initial positions ms | Edge select MST / LocalMap ms | MST drawn / available | LocalMap drawn / available |",
		"|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
	];
	const lines = rows.map((row) =>
		[
			row.count,
			`${row.relations} (${row.density})`,
			ms(row.layout.distancesMs),
			ms(row.layout.mstMs),
			ms(row.layout.centerMs),
			ms(row.layout.neighboursMs),
			ms(row.layout.totalMs),
			ms(row.resultCloneMs),
			mb(row.workingBytes),
			mb(row.vectorBytes),
			mb(row.heapDeltaBytes),
			ms(row.rendererPrepMs.hopDistances),
			ms(row.rendererPrepMs.rootedTree),
			ms(row.rendererPrepMs.initialPositions),
			`${ms(row.edgeSelectionMs.mst)} / ${ms(row.edgeSelectionMs.localMap)}`,
			`${row.counts.mst.drawn} / ${row.counts.mst.available}`,
			`${row.counts.localMap.drawn} / ${row.counts.localMap.available}`,
		].join(" | "),
	);
	return [...header, ...lines.map((line) => `| ${line} |`)].join("\n");
}
