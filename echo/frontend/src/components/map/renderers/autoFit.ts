/**
 * Fit-to-view for both renderers. Keeps every node inside the panel:
 *
 * - Fits once as soon as a layout exists, without waiting for a tick (a
 *   background tab may not tick at all).
 * - After a new layout, a new node set or a new panel size the fit is
 *   "armed" for a while: it may zoom in and recentre as well as zoom out, so
 *   an early spread-out layout or a panel that was briefly narrow while the
 *   page laid itself out cannot lock in a tiny zoom.
 * - Once settled it zooms out when the graph outgrows the view (10% margin,
 *   5% hysteresis), recentres when a node drifts past the edge, and zooms in
 *   only when the graph has clearly shrunk (1.5x), so the breathing layout
 *   does not pump the zoom but a collapsed zoom always recovers.
 * - Skipped while a previous fit animates, and for a panel too small to be
 *   anything but mid-layout. A renderer can stop fitting once the user has
 *   zoomed or panned.
 */
import { fitToViewport } from "../graph/layout";
import { d3, type ZoomBehavior } from "./d3";

/** Ticks between fit checks. */
export const AUTO_FIT_EVERY_TICKS = 10;
/** Room around a node when fitting, as a multiple of its own radius. */
export const FIT_PADDING_SCALE = 4;
const AUTO_FIT_DURATION_MS = 750;
/** Ticks after arming during which a fit may zoom in or recentre. */
const SETTLE_TICKS = 300;
/** A panel smaller than this is still being laid out: no fit is taken from it. */
export const MIN_FIT_SIZE = 48;
/** Zoom in when the fitted zoom exceeds the current one by this factor, while armed. */
const ARMED_ZOOM_IN = 1.05;
/** The same once settled: only a graph that shrank well inside the view. */
const SETTLED_ZOOM_IN = 1.5;

export type AutoFitState = {
	/** Ticks seen by the renderer. */
	tick: number;
	/** Up to this tick a fit may zoom in or recentre. */
	armedUntil: number;
	/** A running fit transition ends at this time (performance.now). */
	endsAt: number;
	/** The user zoomed or panned since the last arming. */
	userZoomed: boolean;
};

export const createAutoFitState = (): AutoFitState => ({
	armedUntil: SETTLE_TICKS,
	endsAt: 0,
	tick: 0,
	userZoomed: false,
});

/** A new layout, node set or panel size: let the next fits zoom either way. */
export function armAutoFit(
	state: AutoFitState,
	{ resetUserZoom = false } = {},
) {
	state.armedUntil = state.tick + SETTLE_TICKS;
	if (resetUserZoom) state.userZoomed = false;
}

/** Stops a running fit and clears its deadline, so the next check can fit at once. */
export function cancelAutoFit(
	svgElement: SVGSVGElement | null,
	state: AutoFitState,
) {
	if (svgElement) d3.select(svgElement).interrupt();
	state.endsAt = 0;
}

type Point = { x?: number; y?: number };

const hasPosition = (point: Point): point is { x: number; y: number } =>
	typeof point.x === "number" &&
	typeof point.y === "number" &&
	Number.isFinite(point.x) &&
	Number.isFinite(point.y);

export type AutoFitOptions<N extends Point> = {
	svgElement: SVGSVGElement | null;
	zoom: ZoomBehavior<SVGSVGElement> | null;
	size: { width: number; height: number };
	nodes: ReadonlyArray<N>;
	/** Room around each node, in graph units. */
	padding: (node: N) => number;
	state: AutoFitState;
	/** Animate the change; false applies it at once. */
	animate: boolean;
	/** Leave the zoom alone once the user has zoomed or panned. */
	respectUserZoom?: boolean;
};

/** Applies a fit when one is due. True when the zoom changed. */
export function autoFit<N extends Point>({
	svgElement,
	zoom,
	size,
	nodes,
	padding,
	state,
	animate,
	respectUserZoom = false,
}: AutoFitOptions<N>): boolean {
	if (!svgElement || !zoom) return false;
	if (respectUserZoom && state.userZoomed) return false;
	if (size.width < MIN_FIT_SIZE || size.height < MIN_FIT_SIZE) return false;
	const now = performance.now();
	if (animate && now < state.endsAt) return false;

	const fit = fitToViewport(nodes, size.width, size.height, padding);
	if (!fit) return false;

	const current = d3.zoomTransform(svgElement);
	const armed = state.tick <= state.armedUntil;
	const target = fit.scale * 0.9;
	const outgrown = fit.scale < current.k * 0.95;
	// Armed, any real gap zooms in. Settled, only a clearly shrunken graph
	// does: breathing moves the extent by a few percent and never reaches it,
	// while a zoom locked in by an early spread or throttled ticks still recovers
	const undersized =
		target > current.k * (armed ? ARMED_ZOOM_IN : SETTLED_ZOOM_IN);
	// A node beyond the panel edge recentres at any time, at the same or a
	// smaller zoom, so a drifting layout never leaves nodes off-panel
	const offScreen =
		!outgrown &&
		!undersized &&
		nodes.some((node) => {
			if (!hasPosition(node)) return false;
			const x = node.x * current.k + current.x;
			const y = node.y * current.k + current.y;
			return x < 0 || x > size.width || y < 0 || y > size.height;
		});
	if (!outgrown && !undersized && !offScreen) return false;

	const scale = outgrown || undersized ? target : Math.min(current.k, target);
	const next = d3.zoomIdentity
		.translate(
			size.width / 2 - fit.centerX * scale,
			size.height / 2 - fit.centerY * scale,
		)
		.scale(scale);

	const svg = d3.select(svgElement);
	if (animate) {
		state.endsAt = now + AUTO_FIT_DURATION_MS;
		svg.transition().duration(AUTO_FIT_DURATION_MS).call(zoom.transform, next);
	} else {
		svg.interrupt();
		state.endsAt = 0;
		svg.call(zoom.transform, next);
	}
	return true;
}
