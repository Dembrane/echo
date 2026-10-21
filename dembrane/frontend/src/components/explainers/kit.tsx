import { Text } from "@mantine/core";
import { useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";

/**
 * Shared drawing kit for the explainer loops behind the "i" next to a feature's title. Every loop
 * is a pure function of the time, so any frame renders on its own and the loop is exact. The
 * visual rules (rounded, one blue for dembrane, six-word lines) are the same as the transcript
 * loop in ImproveTranscriptAnimation.
 */
export const W = 360;
export const H = 176;
export const C = {
	action: "var(--app-action)",
	muted: "var(--app-muted)",
	quiet: "var(--app-quiet)",
	surface: "var(--app-surface)",
	text: "var(--app-text)",
	tint: "var(--app-action-tint)",
};

export const clamp = (v: number, lo = 0, hi = 1) =>
	Math.min(hi, Math.max(lo, v));
export const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
export const smooth = (k: number) => {
	const c = clamp(k);
	return c * c * (3 - 2 * c);
};
/** Fade in at a over d, out at b over d. */
export const win = (t: number, a: number, b: number, d = 0.3) =>
	smooth((t - a) / d) * (1 - smooth((t - b) / d));
/** Unit step response of a spring with a tiny overshoot, 0 before `t0`. */
export const spring = (t: number, t0: number, freq = 1.8, zeta = 0.82) => {
	const x = t - t0;
	if (x <= 0) return 0;
	const w = 2 * Math.PI * freq;
	const wd = w * Math.sqrt(1 - zeta * zeta);
	return (
		1 -
		Math.exp(-zeta * w * x) *
			(Math.cos(wd * x) + ((zeta * w) / wd) * Math.sin(wd * x))
	);
};
// Deterministic: the same picture on every render.
export const rng = (seed: number) => {
	let s = seed;
	return () => {
		s = (s + 0x6d2b79f5) | 0;
		let r = Math.imul(s ^ (s >>> 15), 1 | s);
		r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
		return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
	};
};

export type Word = { x: number; y: number; w: number };
/** Words of one line from x0 to about end, seeded. */
export function lineWords(
	seed: number,
	x0: number,
	y: number,
	end: number,
	min = 8,
	max = 22,
): Word[] {
	const r = rng(seed);
	const out: Word[] = [];
	let x = x0;
	while (true) {
		const w = min + r() * (max - min);
		if (x + w > end) break;
		out.push({ w, x, y });
		x += w + 4;
	}
	return out;
}

/** Text drawn as pill bars, revealed left to right by k (0..1). */
export function Bars({
	words,
	k = 1,
	fill = C.text,
	opacity = 0.8,
	h = 4,
}: {
	words: Word[];
	k?: number;
	fill?: string;
	opacity?: number;
	h?: number;
}) {
	if (k <= 0 || !words.length) return null;
	const start = words[0]!.x;
	const last = words[words.length - 1]!;
	const edge = start + (last.x + last.w - start) * clamp(k);
	return (
		<g>
			{words.map((w) =>
				w.x >= edge ? null : (
					<rect
						key={`${w.x}-${w.y}`}
						x={w.x}
						y={w.y}
						width={Math.min(w.w, edge - w.x)}
						height={h}
						rx={h / 2}
						fill={fill}
						opacity={opacity}
					/>
				),
			)}
		</g>
	);
}

/** A phone outline with an optional recording button. */
export function Phone({
	x,
	y,
	w = 56,
	h = 104,
	t,
	recording = true,
	opacity = 1,
	scale = 1,
	button = true,
}: {
	x: number;
	y: number;
	w?: number;
	h?: number;
	t: number;
	recording?: boolean;
	opacity?: number;
	scale?: number;
	button?: boolean;
}) {
	const pulse = 0.5 + 0.5 * Math.sin(t * 4);
	const cx = x + w / 2;
	const cy = y + h * 0.78;
	return (
		<g
			opacity={opacity}
			transform={`translate(${cx} ${y + h / 2}) scale(${scale}) translate(${-cx} ${-(y + h / 2)})`}
		>
			<rect
				x={x}
				y={y}
				width={w}
				height={h}
				rx={8}
				fill={C.surface}
				stroke={C.text}
				strokeWidth={1.5}
			/>
			<line
				x1={cx - 8}
				x2={cx + 8}
				y1={y + 7}
				y2={y + 7}
				stroke={C.text}
				strokeWidth={1.5}
			/>
			{recording && (
				<circle
					cx={cx}
					cy={cy}
					r={8 + pulse * 3}
					fill="none"
					stroke={C.action}
					strokeWidth={1}
					opacity={(1 - pulse) * 0.6}
				/>
			)}
			{button && (
				<circle
					cx={cx}
					cy={cy}
					r={recording ? 7 : 6}
					fill={recording ? C.action : C.muted}
				/>
			)}
		</g>
	);
}

/** The mouse pointer at (x, y), pressed when press is true. */
export function Cursor({
	x,
	y,
	opacity,
	press,
}: {
	x: number;
	y: number;
	opacity: number;
	press?: boolean;
}) {
	if (opacity < 0.01) return null;
	return (
		<g
			transform={`translate(${x} ${y}) scale(${press ? 0.85 : 1})`}
			opacity={opacity}
		>
			<path
				d="M0 0 L0 13 L3.5 9.8 L6.2 15.4 L8.4 14.4 L5.7 8.9 L10.2 8.6 Z"
				fill={C.text}
				stroke={C.surface}
				strokeWidth={1.2}
				strokeLinejoin="round"
			/>
		</g>
	);
}

export type Loop = {
	seconds: number;
	/** When each line starts; the last line ends at out. */
	scenes: number[];
	out: number;
	/** One line per scene, six words or fewer; a function so it is translated at render. */
	lines: () => string[];
	draw: (t: number) => ReactNode;
};

/** Which scene's line shows at `t`, and how visible it is. */
export function sceneAt(loop: Loop, t: number) {
	let scene = 0;
	for (const [i, s] of loop.scenes.entries()) if (t >= s) scene = i;
	const start = loop.scenes[scene]!;
	const end = loop.scenes[scene + 1] ?? loop.out + 0.2;
	return {
		opacity: smooth((t - start) / 0.35) * (1 - smooth((t - end + 0.3) / 0.3)),
		scene,
	};
}

export function Frame({ loop, t }: { loop: Loop; t: number }) {
	const out = 1 - smooth((t - loop.out) / 0.6);
	const caption = sceneAt(loop, t);
	return (
		<div>
			<svg
				viewBox={`0 0 ${W} ${H}`}
				width="100%"
				style={{ display: "block" }}
				role="presentation"
				aria-hidden="true"
			>
				<g opacity={out}>{loop.draw(t)}</g>
			</svg>
			<Text
				size="sm"
				mt={6}
				h="3em"
				style={{ opacity: caption.opacity * out }}
				data-testid="explainer-line"
			>
				{loop.lines()[caption.scene]}
			</Text>
		</div>
	);
}

/** The loop from the start each time it is shown; still on its last scene for reduced motion. */
export function Player({ loop }: { loop: Loop }) {
	const reduced = useReducedMotion();
	const still = loop.scenes[loop.scenes.length - 1]! + 1.5;
	const [t, setT] = useState(reduced ? still : 0);
	useEffect(() => {
		if (reduced) return;
		let frame = 0;
		const start = performance.now();
		const tick = (now: number) => {
			setT(((now - start) / 1000) % loop.seconds);
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [reduced, loop.seconds]);
	return <Frame loop={loop} t={t} />;
}
