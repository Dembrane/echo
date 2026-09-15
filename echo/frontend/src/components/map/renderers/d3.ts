/**
 * Typed entry point to d3 for the map renderers.
 *
 * The dashboard depends on d3 7, which ships no type declarations, and only
 * the d3-selection, d3-transition, d3-array and d3-scale types are installed.
 * This module imports the d3 bundle once and describes the subset the
 * renderers use, so they stay typed without adding a dependency.
 */
// @ts-expect-error d3 ships no declarations and @types/d3 is not installed; the subset used here is typed below.
import * as d3Bundle from "d3";
import type { BaseType, Selection, select } from "d3-selection";
import type { Transition } from "d3-transition";

export type { BaseType, Selection };

export interface SimulationNodeDatum {
	index?: number;
	x?: number;
	y?: number;
	vx?: number;
	vy?: number;
	fx?: number | null;
	fy?: number | null;
}

export interface Force<N extends SimulationNodeDatum> {
	(alpha: number): void;
	initialize?: (nodes: N[], random: () => number) => void;
}

export interface Simulation<N extends SimulationNodeDatum> {
	nodes(): N[];
	nodes(nodes: N[]): this;
	alpha(): number;
	alpha(alpha: number): this;
	alphaDecay(decay: number): this;
	alphaTarget(target: number): this;
	restart(): this;
	stop(): this;
	force(name: string): Force<N> | undefined;
	force(name: string, force: Force<N> | null): this;
	on(typenames: string, listener: (() => void) | null): this;
}

export interface ForceLink<N extends SimulationNodeDatum, L> extends Force<N> {
	links(): L[];
	links(links: L[]): this;
	id(id: (node: N) => string): this;
	distance(distance: number | ((link: L) => number)): this;
	strength(strength: number | ((link: L) => number)): this;
}

export interface ForceManyBody<N extends SimulationNodeDatum> extends Force<N> {
	strength(strength: number): this;
	distanceMax(distance: number): this;
}

export interface ForceCenter<N extends SimulationNodeDatum> extends Force<N> {
	x(x: number): this;
	y(y: number): this;
	strength(strength: number): this;
}

export interface ForceCollide<N extends SimulationNodeDatum> extends Force<N> {
	radius(radius: number): this;
	strength(strength: number): this;
}

export interface ZoomTransform {
	readonly k: number;
	readonly x: number;
	readonly y: number;
	scale(k: number): ZoomTransform;
	translate(x: number, y: number): ZoomTransform;
	toString(): string;
}

export interface ZoomBehavior<E extends Element> {
	(selection: Selection<E, unknown, null, undefined>): void;
	scaleExtent(extent: [number, number]): this;
	on(
		typenames: string,
		listener: (event: { transform: ZoomTransform }) => void,
	): this;
	transform(
		target:
			| Selection<E, unknown, null, undefined>
			| Transition<E, unknown, null, undefined>,
		transform: ZoomTransform,
	): void;
}

export interface DragEvent {
	active: number;
	x: number;
	y: number;
}

export interface DragBehavior<E extends Element, D> {
	<P extends BaseType, PD>(selection: Selection<E, D, P, PD>): void;
	on(typenames: string, listener: (event: DragEvent, datum: D) => void): this;
}

export interface Arc {
	(...args: unknown[]): string | null;
	innerRadius(radius: number | (() => number)): this;
	outerRadius(radius: number | (() => number)): this;
	startAngle(angle: number): this;
	endAngle(angle: number): this;
}

interface D3Subset {
	select: typeof select;
	zoom<E extends Element>(): ZoomBehavior<E>;
	zoomIdentity: ZoomTransform;
	zoomTransform(node: Element): ZoomTransform;
	forceSimulation<N extends SimulationNodeDatum>(nodes?: N[]): Simulation<N>;
	forceLink<N extends SimulationNodeDatum, L>(links?: L[]): ForceLink<N, L>;
	forceManyBody<N extends SimulationNodeDatum>(): ForceManyBody<N>;
	forceCenter<N extends SimulationNodeDatum>(
		x?: number,
		y?: number,
	): ForceCenter<N>;
	forceCollide<N extends SimulationNodeDatum>(): ForceCollide<N>;
	drag<E extends Element, D>(): DragBehavior<E, D>;
	arc(): Arc;
	easeCubicOut(normalizedTime: number): number;
}

export const d3: D3Subset = d3Bundle;
