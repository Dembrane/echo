/**
 * Force formulas and custom d3 forces for the map renderers. Plain functions
 * over node objects (no d3 import), so they run and test without a DOM.
 */

/** The fields a simulation node carries; d3 fills in x, y, vx and vy. */
export interface ForceNode {
	id: string;
	x?: number;
	y?: number;
	vx?: number;
	vy?: number;
}

type PositionedNode<N extends ForceNode> = N & { x: number; y: number };

/** A pair of node ids a pair force acts on. */
export type ForcePair = { source: string; target: string };

/** Quadratic, linear and constant coefficients of the MST link length. */
export type MstLinkDistanceParams = {
	quadratic: number;
	linear: number;
	constant: number;
};

export type MstForceParams = {
	link: MstLinkDistanceParams;
	/** Base charge; negative repels. */
	chargeStrength: number;
	/** Linear coefficient of the MST hop repulsion. */
	mstRepulsionCoeff: number;
};

export const MST_FORCE_DEFAULTS: MstForceParams = {
	chargeStrength: -4,
	link: { constant: 8, linear: 1, quadratic: 1 },
	mstRepulsionCoeff: 0.01,
};

export type LocalMapForceParams = {
	/** C_Med from the LocalMAP paper. */
	cMed: number;
	/** d̄_adj from the LocalMAP paper. */
	dAdj: number;
	nnStrength: number;
	fpStrength: number;
	/** Negative repels. */
	chargeStrength: number;
	/** Collision radius as a multiple of the node radius. */
	collisionRadius: number;
	/** Charge distanceMax as a fraction of min(width, height). */
	chargeFraction: number;
};

export const LOCAL_MAP_FORCE_DEFAULTS: LocalMapForceParams = {
	chargeFraction: 0.4,
	chargeStrength: -10,
	cMed: 10,
	collisionRadius: 2,
	dAdj: 10,
	fpStrength: 2,
	nnStrength: 0.1,
};

/** Fruchterman-Reingold ideal spacing for n nodes in a width x height area. */
export function fruchtermanReingoldK(
	width: number,
	height: number,
	nodeCount: number,
): number {
	return Math.sqrt((width * height) / Math.max(1, nodeCount));
}

/**
 * Target length of an MST link: (q d² + l d + c) x k / 12, with the cosine
 * distance d clamped to [0, 1] (1 when it is not a finite number).
 */
export function mstLinkDistance(
	cosineDistance: number,
	params: MstLinkDistanceParams,
	k: number,
): number {
	const d = Number.isFinite(cosineDistance)
		? Math.max(0, Math.min(1, cosineDistance))
		: 1;
	const unscaled =
		params.quadratic * d * d + params.linear * d + params.constant;
	return unscaled * (k / 12);
}

/** Viewport-dependent MST forces for the current size and node count. */
export function mstViewportForces(
	width: number,
	height: number,
	nodeCount: number,
): {
	k: number;
	centerX: number;
	centerY: number;
	chargeDistanceMax: number;
	mstRepulsionMaxDistance: number;
} {
	const k = fruchtermanReingoldK(width, height, nodeCount);
	return {
		centerX: width / 2,
		centerY: height / 2,
		chargeDistanceMax: k * 4,
		k,
		mstRepulsionMaxDistance: Math.max(width, height) * 10,
	};
}

const hasPosition = <N extends ForceNode>(node: N): node is PositionedNode<N> =>
	typeof node.x === "number" &&
	typeof node.y === "number" &&
	Number.isFinite(node.x) &&
	Number.isFinite(node.y);

const addVelocity = (node: ForceNode, fx: number, fy: number) => {
	if (typeof node.vx === "number" && typeof node.vy === "number") {
		node.vx += fx;
		node.vy += fy;
	}
};

export interface MstRepulsionForce<N extends ForceNode> {
	(alpha: number): void;
	initialize(nodes: N[]): void;
	setDistances(distances: Map<string, Map<string, number>>): this;
	setMaxDistance(max: number): this;
	setStrength(strength: number): this;
}

/** Repulsion between every node pair, proportional to their hop distance in the tree. */
export function createMstRepulsionForce<N extends ForceNode>(
	initialDistances: Map<string, Map<string, number>>,
	initialStrength = MST_FORCE_DEFAULTS.mstRepulsionCoeff,
): MstRepulsionForce<N> {
	let nodes: N[] = [];
	let mstDistances = initialDistances;
	let maxDistance = 1;
	let strength = initialStrength;

	const force = ((alpha: number) => {
		for (let i = 0; i < nodes.length; i++) {
			const nodeA = nodes[i];
			const distances = mstDistances.get(nodeA.id);
			if (!distances || !hasPosition(nodeA)) continue;

			for (let j = i + 1; j < nodes.length; j++) {
				const nodeB = nodes[j];
				const mstDistance = distances.get(nodeB.id);
				if (!mstDistance || !hasPosition(nodeB)) continue;

				const dx = nodeB.x - nodeA.x;
				const dy = nodeB.y - nodeA.y;
				const distance = Math.hypot(dx, dy);
				if (distance === 0 || distance > maxDistance) continue;

				const forceAmount = (strength * mstDistance * alpha) / distance;
				const fx = (dx / distance) * forceAmount;
				const fy = (dy / distance) * forceAmount;

				addVelocity(nodeA, -fx, -fy);
				addVelocity(nodeB, fx, fy);
			}
		}
	}) as MstRepulsionForce<N>;

	force.initialize = (initNodes) => {
		nodes = initNodes;
	};
	force.setDistances = (distances) => {
		mstDistances = distances;
		return force;
	};
	force.setMaxDistance = (max) => {
		maxDistance = max;
		return force;
	};
	force.setStrength = (value) => {
		strength = value;
		return force;
	};

	return force;
}

export interface PairForce<N extends ForceNode> {
	(alpha: number): void;
	initialize(nodes: N[]): void;
	setLinks(links: ReadonlyArray<ForcePair>): this;
	setStrength(strength: number): this;
}

export interface NearestNeighbourForce<N extends ForceNode>
	extends PairForce<N> {
	setCMed(cMed: number): this;
	setDAdj(dAdj: number): this;
}

/** Shared pair loop: resolves ids to nodes and skips pairs without a finite position. */
function createPairForce<N extends ForceNode>(
	initialLinks: ReadonlyArray<ForcePair>,
	apply: (
		source: PositionedNode<N>,
		target: PositionedNode<N>,
		alpha: number,
		strength: number,
	) => void,
): PairForce<N> {
	let nodeById = new Map<string, N>();
	let links = initialLinks;
	let strength = 1;

	const force = ((alpha: number) => {
		for (const link of links) {
			const source = nodeById.get(link.source);
			const target = nodeById.get(link.target);
			if (!source || !target || !hasPosition(source) || !hasPosition(target)) {
				continue;
			}
			apply(source, target, alpha, strength);
		}
	}) as PairForce<N>;

	force.initialize = (nodes) => {
		nodeById = new Map(nodes.map((node) => [node.id, node]));
	};
	force.setLinks = (next) => {
		links = next;
		return force;
	};
	force.setStrength = (value) => {
		strength = value;
		return force;
	};

	return force;
}

// LocalMAP losses (https://arxiv.org/pdf/2412.15426), with d̃ = ||y_i - y_j||² + 1
// NN loss: d̄_adj · d̃² / (C_Med + d̃)
// FP loss: 1 / (1 + d̃)

/** Attraction between nearest-neighbour pairs by the LocalMAP NN loss. */
export function createNearestNeighbourForce<N extends ForceNode>(
	initialLinks: ReadonlyArray<ForcePair>,
	initialCMed: number,
	initialDAdj: number,
): NearestNeighbourForce<N> {
	let cMed = initialCMed;
	let dAdj = initialDAdj;

	const force = createPairForce<N>(
		initialLinks,
		(source, target, alpha, strength) => {
			const dx = target.x - source.x;
			const dy = target.y - source.y;
			const distSq = dx * dx + dy * dy;
			const dTilde = distSq + 1;

			// ∂Loss/∂d̃ = d̄_adj · (2·d̃·C_Med) / (C_Med + d̃)²; ∂d̃/∂distance = 2·distance
			const dLossDDTilde = (dAdj * (2 * dTilde * cMed)) / (cMed + dTilde) ** 2;
			const distance = Math.sqrt(distSq) || 1e-10;
			const forceValue = strength * alpha * dLossDDTilde * 2 * distance;
			const fx = (dx / distance) * forceValue;
			const fy = (dy / distance) * forceValue;

			addVelocity(source, fx, fy);
			addVelocity(target, -fx, -fy);
		},
	) as NearestNeighbourForce<N>;

	force.setCMed = (value) => {
		cMed = value;
		return force;
	};
	force.setDAdj = (value) => {
		dAdj = value;
		return force;
	};

	return force;
}

/** Repulsion between further pairs by the LocalMAP FP loss. */
export function createFurtherPairForce<N extends ForceNode>(
	initialLinks: ReadonlyArray<ForcePair>,
): PairForce<N> {
	return createPairForce<N>(initialLinks, (source, target, alpha, strength) => {
		const dx = target.x - source.x;
		const dy = target.y - source.y;
		const distSq = dx * dx + dy * dy;
		const dTilde = distSq + 1;

		// ∂Loss/∂d̃ = -1 / (1 + d̃)²; ∂d̃/∂distance = 2·distance
		const dLossDDTilde = -1.0 / (dTilde * dTilde);
		const distance = Math.sqrt(distSq) || 1e-10;
		const forceValue = strength * alpha * dLossDDTilde * 2 * distance * 10;
		const fx = (dx / distance) * forceValue;
		const fy = (dy / distance) * forceValue;

		addVelocity(source, fx, fy);
		addVelocity(target, -fx, -fy);
	});
}
