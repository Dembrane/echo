import { useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";

/**
 * A twelve second loop, no words, of what happens to a transcript: it arrives in rough parts
 * while people talk, the whole recording is heard again when the conversation ends, and clean
 * paragraphs replace the parts, each sentence playable. Every value is a function of the time,
 * so a frame can be rendered on its own (the review recording seeks it) and the loop is exact.
 */
export const LOOP_SECONDS = 12;

const W = 320;
const H = 188;
const X0 = 24;
const X1 = 296;
const BARS = 40;
const STEP = (X1 - X0) / (BARS - 1);
const WAVE_Y = 30;
const PARTS = 4;
const PER_PART = BARS / PARTS;

// Deterministic: the same picture on every render and in every recording.
const rng = (seed: number) => {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let r = Math.imul(state ^ (state >>> 15), 1 | state);
		r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
		return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
	};
};

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const smooth = (k: number) => {
	const c = clamp(k);
	return c * c * (3 - 2 * c);
};
/** Unit step response of a spring with a tiny overshoot, 0 before `t0`. */
const spring = (t: number, t0: number, freq = 1.8, zeta = 0.82) => {
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
/** Fades in at `a`, out at `b`, each over `d` seconds. */
const window_ = (t: number, a: number, b: number, d = 0.35) =>
	smooth((t - a) / d) * (1 - smooth((t - b) / d));

const heights = (() => {
	const r = rng(7);
	return Array.from({ length: BARS }, (_, i) => {
		const pause = i % PER_PART === PER_PART - 1;
		return pause
			? 2.5
			: 4 + 10 * Math.abs(Math.sin(i * 0.9) * 0.55 + r() * 0.6);
	});
})();

type Word = { x: number; y: number; w: number };

/** Rough parts: two short lines each, one word missing, a word cut where the part ends. */
const roughParts = (() => {
	const r = rng(21);
	return Array.from({ length: PARTS }, (_, p) => {
		const top = 64 + p * 30;
		const words: (Word & { missing?: boolean; cut?: boolean })[] = [];
		for (let line = 0; line < 2; line++) {
			let x = X0 + 14;
			const end = line === 0 ? X1 - r() * 30 : X0 + 120 + r() * 90;
			while (x < end) {
				const w = 8 + r() * 20;
				if (x + w > end) break;
				words.push({ w, x, y: top + line * 10 });
				x += w + 4;
			}
		}
		const missing = words[3 + Math.floor(r() * (words.length - 5))];
		if (missing) missing.missing = true;
		const last = words[words.length - 1];
		if (last) last.cut = true;
		return { top, words };
	});
})();

/** Clean paragraphs: full lines, even gaps, sentences that can be highlighted. */
const clean = (() => {
	const r = rng(5);
	const lines: Word[][] = [];
	const paragraphOf: number[] = [];
	let y = 64;
	for (const [para, count] of [3, 2, 3].entries()) {
		for (let l = 0; l < count; l++) {
			const end = l === count - 1 ? X0 + 110 + r() * 110 : X1;
			const line: Word[] = [];
			let x = X0;
			while (true) {
				const w = 8 + r() * 22;
				if (x + w > end) break;
				line.push({ w, x, y });
				x += w + 4;
			}
			lines.push(line);
			for (const _ of line) paragraphOf.push(para);
			y += 11;
		}
		y += 7;
	}
	const words = lines.flat();
	// Sentences of five to nine words, in reading order, never across a paragraph.
	const sentences: [number, number][] = [];
	let i = 0;
	while (i < words.length) {
		let n = Math.min(words.length - i, 5 + Math.floor(r() * 5));
		while (n > 1 && paragraphOf[i + n - 1] !== paragraphOf[i]) n--;
		const rest = words.length - (i + n);
		if (rest > 0 && rest < 3 && paragraphOf[i + n] === paragraphOf[i])
			n += rest;
		sentences.push([i, i + n - 1]);
		i += n;
	}
	return { lines, sentences, words };
})();

/** Rectangles behind a sentence, one per line it spans. */
const sentenceBoxes = (s: [number, number]) => {
	const boxes: { x: number; y: number; w: number }[] = [];
	for (let i = s[0]; i <= s[1]; i++) {
		const w = clean.words[i] as Word;
		const last = boxes[boxes.length - 1];
		if (last && last.y === w.y) last.w = w.x + w.w - last.x;
		else boxes.push({ w: w.w, x: w.x, y: w.y });
	}
	return boxes.map((b) => ({ w: b.w + 4, x: b.x - 2, y: b.y - 3 }));
};

// The playback part: which sentence is heard when, and a click on a later one.
const CLICK_AT = 9.3;
const CLICKED = 4;
const playing = (t: number) => {
	if (t < 8.1) return -1;
	if (t < 8.75) return 0;
	if (t < CLICK_AT) return 1;
	if (t < 10.1) return CLICKED;
	if (t < 10.85) return CLICKED + 1;
	return CLICKED + 2;
};
const sentenceX = (s: number) =>
	X0 + ((s + 0.5) / clean.sentences.length) * (X1 - X0);

export function ImproveTranscriptFrame({ t }: { t: number }) {
	const text = "var(--app-text)";
	const muted = "var(--app-muted)";
	const action = "var(--app-action)";
	// Everything leaves together before the loop starts again.
	const out = 1 - smooth((t - 11.2) / 0.6);

	const recordHead = X0 + clamp((t - 0.2) / 3.8) * (X1 - X0);
	const recording = t > 0.2 && t < 4.2;
	const sweep = X0 + smooth((t - 4.8) / 2) * (X1 - X0);
	const sweeping = t > 4.8 && t < 6.9;
	const divider = 1 - smooth((t - 4.4) / 0.4);
	const now = playing(t);
	const nowX = now >= 0 ? sentenceX(now) : X0;
	const cursorIn = spring(t, 8.5, 1.4);
	const cursorTarget = sentenceBoxes(
		clean.sentences[CLICKED] as [number, number],
	)[0] ?? { w: 20, x: X0, y: 64 };
	const cx = lerp(W + 10, cursorTarget.x + cursorTarget.w * 0.4, cursorIn);
	const cy = lerp(H + 10, cursorTarget.y + 7, cursorIn);
	const press = t > CLICK_AT - 0.08 && t < CLICK_AT + 0.12 ? 0.85 : 1;
	const cursorOpacity =
		smooth((t - 8.5) / 0.3) * (1 - smooth((t - 10.4) / 0.4));

	return (
		<svg
			viewBox={`0 0 ${W} ${H}`}
			width="100%"
			role="presentation"
			aria-hidden="true"
		>
			<g opacity={out}>
				{/* The recording: bars appear as people talk, one recording when it ends. */}
				{heights.map((h, i) => {
					const x = X0 + i * STEP;
					const grow = spring(t, 0.2 + (i / BARS) * 3.8, 2.4);
					const heard =
						sweeping || t >= 6.9
							? smooth((sweep - x) / 14) * (1 - smooth((t - 7.4) / 0.6))
							: 0;
					const hh = h * grow;
					return (
						<rect
							key={`b${x}`}
							x={x - 1.5}
							y={WAVE_Y - hh}
							width={3}
							height={hh * 2}
							fill={heard > 0.01 ? action : text}
							opacity={0.75 + heard * 0.25}
						/>
					);
				})}
				{/* Where each part ends while recording; gone once it is one recording. */}
				{[1, 2, 3].map((p) => {
					const x = X0 + (p * PER_PART - 0.5) * STEP;
					const shown = clamp((recordHead - x) / 4) * divider;
					return (
						<line
							key={`d${p}`}
							x1={x}
							x2={x}
							y1={WAVE_Y - 17}
							y2={WAVE_Y + 17}
							stroke={muted}
							strokeWidth={1}
							strokeDasharray="2 2"
							opacity={shown * 0.8}
						/>
					);
				})}
				{/* The head while recording, then a stop. */}
				{t < 4.7 && (
					<rect
						x={recordHead + 4 - (recording ? 3 : 4)}
						y={WAVE_Y - (recording ? 3 : 4)}
						width={recording ? 6 : 8}
						height={recording ? 6 : 8}
						rx={recording ? 3 : 0}
						fill={action}
						opacity={smooth((t - 0.2) / 0.3) * (1 - smooth((t - 4.4) / 0.3))}
					/>
				)}
				{/* Heard again from start to end. */}
				<line
					x1={sweep}
					x2={sweep}
					y1={WAVE_Y - 20}
					y2={WAVE_Y + 20}
					stroke={action}
					strokeWidth={2}
					opacity={window_(t, 4.8, 6.75, 0.2)}
				/>

				{/* Rough parts, each with its own play mark, arriving as each part ends. */}
				{roughParts.map((part, p) => {
					const arrive = spring(
						t,
						0.2 + (((p + 1) * PER_PART) / BARS) * 3.8 + 0.25,
						2,
					);
					const partX = X0 + (p * PER_PART + PER_PART / 2) * STEP;
					const leave = t > 4.8 ? 1 - smooth((sweep - partX + 30) / 30) : 1;
					const o = clamp(arrive) * leave;
					if (o < 0.01) return null;
					const dy = (1 - arrive) * 6;
					return (
						<g
							key={`p${part.top}`}
							opacity={o}
							transform={`translate(0 ${dy})`}
						>
							<path
								d={`M ${X0} ${part.top - 3} l 6 3.5 l -6 3.5 z`}
								fill={muted}
							/>
							{part.words.map((w) =>
								w.missing ? (
									<rect
										key={`${w.x}-${w.y}`}
										x={w.x + 0.5}
										y={w.y + 0.5}
										width={w.w - 1}
										height={3}
										fill="none"
										stroke={muted}
										strokeWidth={1}
										strokeDasharray="2 1.5"
									/>
								) : (
									<rect
										key={`${w.x}-${w.y}`}
										x={w.x}
										y={w.y}
										width={w.cut ? w.w * 0.45 : w.w}
										height={4}
										fill={muted}
										opacity={0.6}
									/>
								),
							)}
						</g>
					);
				})}

				{/* Clean paragraphs, line by line. */}
				{clean.sentences.map((s, i) =>
					sentenceBoxes(s).map((b) => (
						<rect
							key={`h${i}-${b.y}`}
							x={b.x}
							y={b.y}
							width={b.w}
							height={10}
							fill={action}
							opacity={
								now === i
									? 0.2 * clamp(spring(t, i === CLICKED ? CLICK_AT : 0, 3))
									: 0
							}
						/>
					)),
				)}
				{clean.lines.map((line, l) => {
					const k = spring(t, 6.9 + l * 0.1, 1.6);
					if (k <= 0) return null;
					return (
						<g
							key={`l${line[0]?.y}`}
							opacity={clamp(k)}
							transform={`translate(0 ${(1 - k) * 5})`}
						>
							{line.map((w) => (
								<rect
									key={`${w.x}`}
									x={w.x}
									y={w.y}
									width={w.w * clamp(k * 1.2)}
									height={4}
									fill={text}
									opacity={0.8}
								/>
							))}
						</g>
					);
				})}

				{/* Playing one sentence: its place in the recording. */}
				{now >= 0 && (
					<line
						x1={nowX}
						x2={nowX}
						y1={WAVE_Y - 18}
						y2={WAVE_Y + 18}
						stroke={action}
						strokeWidth={2}
						opacity={smooth((t - 8.1) / 0.3)}
					/>
				)}

				{/* A click on a sentence plays it from there. */}
				{cursorOpacity > 0.01 && (
					<g
						transform={`translate(${cx} ${cy}) scale(${press})`}
						opacity={cursorOpacity}
					>
						<path
							d="M0 0 L0 13 L3.5 9.8 L6.2 15.4 L8.4 14.4 L5.7 8.9 L10.2 8.6 Z"
							fill={text}
							stroke="var(--app-surface)"
							strokeWidth={1.2}
							strokeLinejoin="round"
						/>
					</g>
				)}
			</g>
		</svg>
	);
}

/** The loop, from the start each time it is shown; still on the clean result for reduced motion. */
export function ImproveTranscriptAnimation() {
	const reduced = useReducedMotion();
	const [t, setT] = useState(reduced ? 10 : 0);
	useEffect(() => {
		if (reduced) return;
		let frame = 0;
		const start = performance.now();
		const tick = (now: number) => {
			setT(((now - start) / 1000) % LOOP_SECONDS);
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [reduced]);
	return <ImproveTranscriptFrame t={t} />;
}
