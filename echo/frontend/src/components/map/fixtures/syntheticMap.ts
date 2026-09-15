import type {
	FactCheckState,
	MapGraphNode,
	MapKind,
	MapValence,
} from "../types";

/** Small seeded PRNG (mulberry32): same seed, same sequence. */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let r = Math.imul(a ^ (a >>> 15), 1 | a);
		r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
		return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
	};
}

export type SyntheticMapOptions = {
	count: number;
	seed?: number;
	dims?: number;
	clusters?: number;
	/** Per-dimension noise around a cluster centroid. */
	spread?: number;
};

const VALENCES: MapValence[] = ["positive", "negative", "neutral"];

const FACT_CHECKS: FactCheckState[] = [
	{ status: "idle" },
	{ startedAt: "2026-01-01T00:00:00.000Z", status: "processing" },
	{
		checkedAt: "2026-01-01T00:00:00.000Z",
		justification: "Synthetic justification",
		sources: [{ title: "Synthetic source", url: "https://example.org" }],
		status: "done",
		verdict: "true",
	},
	{
		checkedAt: "2026-01-01T00:00:00.000Z",
		justification: "Synthetic justification",
		sources: [],
		status: "done",
		verdict: "contested",
	},
	{
		at: "2026-01-01T00:00:00.000Z",
		message: "Synthetic error",
		status: "error",
	},
];

/**
 * Deterministic map nodes in a few clusters of a low-dimensional embedding
 * space, with mixed kinds and valences. Labels are fictional.
 */
export function createSyntheticMap({
	count,
	seed = 42,
	dims = 32,
	clusters = 4,
	spread = 0.35,
}: SyntheticMapOptions): MapGraphNode[] {
	const random = mulberry32(seed);
	const centroids = Array.from({ length: clusters }, () =>
		Array.from({ length: dims }, () => random() * 2 - 1),
	);
	const start = Date.UTC(2026, 0, 1);

	return Array.from({ length: count }, (_, index) => {
		const centroid = centroids[index % clusters];
		const embedding = centroid.map(
			(value) => value + (random() * 2 - 1) * spread,
		);
		const kind: MapKind = random() < 0.3 ? "claim" : "argument";
		const valence = VALENCES[Math.floor(random() * VALENCES.length)];
		const label =
			kind === "claim"
				? `Synthetic claim ${index}`
				: `Synthetic argument ${index}`;

		return {
			embedding,
			id: `synthetic-${index}`,
			label,
			metadata: {
				conversationIds: [`synthetic-conversation-${index % 7}`],
				createdAt: new Date(start + index * 60_000).toISOString(),
				factCheck:
					kind === "claim"
						? FACT_CHECKS[index % FACT_CHECKS.length]
						: undefined,
				kind,
				quotes: [`Synthetic quote ${index}`],
				valence,
			},
		};
	});
}
