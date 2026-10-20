import { t as translate } from "@lingui/core/macro";
import { Text } from "@mantine/core";
import { useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";

/**
 * A twenty second loop of what happens to a transcript, one plain line per scene: a phone
 * records and the text comes in piece by piece; when the conversation ends the pieces become
 * one recording that is heard again; clean paragraphs replace the pieces, with the project's
 * key terms in place; a click on a sentence plays it. Every value is a function of the time,
 * so a frame can be rendered on its own (the review recording seeks it) and the loop is exact.
 */
export const LOOP_SECONDS = 20;

const W = 360;
const H = 176;
const X0 = 98;
const X1 = 348;
const STRIP_Y = 14;
const BARS = 36;
const ROWS = 4;
const ROW_Y = (k: number) => 36 + k * 34;
const PHONE = { h: 112, w: 60, x: 12, y: 18 };
const LAUNCH = (k: number) => 0.9 + k * 1.25;
const STOP_AT = 6;
const SWEEP = [7.6, 9.8] as const;
const CLEAN_AT = 10.1;
const TERMS_AT = 11.1;
const CLICK_AT = 16.2;
const OUT_AT = 19.2;

/** When each scene's line starts. */
const SCENES = [0.2, STOP_AT, 10.6, 15] as const;

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

const strip = (() => {
	const r = rng(7);
	return Array.from(
		{ length: BARS },
		(_, i) => 1.5 + 5.5 * Math.abs(Math.sin(i * 0.9) * 0.55 + r() * 0.6),
	);
})();

type Word = { x: number; y: number; w: number };

/** The pieces as they come in: two short lines each, one word missing, the last word cut. */
const rough = (() => {
	const r = rng(21);
	return Array.from({ length: ROWS }, (_, k) => {
		const top = ROW_Y(k);
		const words: (Word & { missing?: boolean; cut?: boolean })[] = [];
		for (let line = 0; line < 2; line++) {
			let x = X0 + 14;
			const end = line === 0 ? X1 - r() * 24 : X0 + 90 + r() * 80;
			while (x < end) {
				const w = 8 + r() * 18;
				if (x + w > end) break;
				words.push({ w, x, y: top + line * 10 });
				x += w + 4;
			}
		}
		const missing = words[2 + Math.floor(r() * (words.length - 4))];
		if (missing) missing.missing = true;
		const last = words[words.length - 1];
		if (last) last.cut = true;
		return { top, words };
	});
})();

/** Clean paragraphs: full lines, even gaps, sentences inside one paragraph each. */
const clean = (() => {
	const r = rng(5);
	const lines: Word[][] = [];
	const paragraphOf: number[] = [];
	let y = 34;
	for (const [para, count] of [3, 2, 3].entries()) {
		for (let l = 0; l < count; l++) {
			const end = l === count - 1 ? X0 + 100 + r() * 100 : X1;
			const line: Word[] = [];
			let x = X0;
			while (true) {
				const w = 8 + r() * 20;
				if (x + w > end) break;
				line.push({ w, x, y });
				x += w + 4;
			}
			lines.push(line);
			for (const _ of line) paragraphOf.push(para);
			y += 12;
		}
		y += 8;
	}
	const words = lines.flat();
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

// Two words that are the project's key terms: one early, one in the last paragraph.
const TERM_WORDS = [3, clean.words.length - 9];
const TERM_CHIP = { h: 14, w: 52, x: PHONE.x + 4, y: PHONE.y + PHONE.h + 14 };

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

const CLICKED = 4;
const playing = (t: number) => {
	if (t < 15.3) return -1;
	if (t < 15.8) return 0;
	if (t < CLICK_AT) return 1;
	if (t < 17.3) return CLICKED;
	if (t < 18.3) return CLICKED + 1;
	return CLICKED + 2;
};
const sentenceX = (s: number) =>
	X0 + ((s + 0.5) / clean.sentences.length) * (X1 - X0);

/** Which scene's line shows at `t`, and how visible it is. */
export function sceneAt(t: number): { scene: number; opacity: number } {
	let scene = 0;
	for (const [i, start] of SCENES.entries()) if (t >= start) scene = i;
	const start = SCENES[scene] as number;
	const end = (SCENES[scene + 1] as number | undefined) ?? OUT_AT + 0.2;
	return {
		opacity: smooth((t - start) / 0.35) * (1 - smooth((t - end + 0.3) / 0.3)),
		scene,
	};
}

export function ImproveTranscriptFrame({
	t,
	lines,
}: {
	t: number;
	lines?: readonly string[];
}) {
	const text = "var(--app-text)";
	const muted = "var(--app-muted)";
	const action = "var(--app-action)";
	const surface = "var(--app-surface)";
	// Everything leaves together before the loop starts again.
	const out = 1 - smooth((t - OUT_AT) / 0.6);
	const stopped = t >= STOP_AT;
	const stopK = spring(t, STOP_AT, 2.4);
	const sweepK = smooth((t - SWEEP[0]) / (SWEEP[1] - SWEEP[0]));
	const sweepX = lerp(X0, X1, sweepK);
	const sweeping = t > SWEEP[0] && t < SWEEP[1] + 0.2;
	const now = playing(t);
	const nowX = now >= 0 ? sentenceX(now) : X0;
	const target = sentenceBoxes(
		clean.sentences[CLICKED] as [number, number],
	)[0] ?? { w: 20, x: X0, y: 40 };
	const cursorIn = spring(t, 15.6, 1.4);
	const cx = lerp(W + 10, target.x + target.w * 0.4, cursorIn);
	const cy = lerp(H + 10, target.y + 7, cursorIn);
	const press = t > CLICK_AT - 0.08 && t < CLICK_AT + 0.12 ? 0.85 : 1;
	const cursorOpacity =
		smooth((t - 15.6) / 0.3) * (1 - smooth((t - 17.6) / 0.4));
	const caption = sceneAt(t);
	const button = {
		cx: PHONE.x + PHONE.w / 2,
		cy: PHONE.y + 88,
		pulse: stopped ? 0 : 0.5 + 0.5 * Math.sin(t * 4),
		radius: lerp(8, 2, clamp(stopK)),
		size: lerp(16, 12, clamp(stopK)),
	};
	const termShow =
		smooth((t - TERMS_AT) / 0.3) * (1 - smooth((t - 14.6) / 0.4));

	return (
		<div>
			<svg
				viewBox={`0 0 ${W} ${H}`}
				width="100%"
				role="presentation"
				aria-hidden="true"
				style={{ display: "block" }}
			>
				<g opacity={out}>
					{/* The phone: recording while people talk, stopped when the conversation ends. */}
					<g opacity={smooth(t / 0.4)}>
						<rect
							x={PHONE.x}
							y={PHONE.y}
							width={PHONE.w}
							height={PHONE.h}
							rx={9}
							fill="none"
							stroke={text}
							strokeWidth={1.5}
						/>
						<line
							x1={PHONE.x + 22}
							x2={PHONE.x + 38}
							y1={PHONE.y + 7}
							y2={PHONE.y + 7}
							stroke={text}
							strokeWidth={1.5}
						/>
						{Array.from({ length: 7 }, (_, i) => {
							const live = stopped ? 1 - clamp(stopK) : 1;
							const h = 1.5 + live * 9 * Math.abs(Math.sin(t * 5.3 + i * 1.7));
							const x = PHONE.x + 12 + i * 6;
							return (
								<rect
									key={`m${x}`}
									x={x - 1.25}
									y={PHONE.y + 46 - h}
									width={2.5}
									height={h * 2}
									fill={text}
									opacity={0.7}
								/>
							);
						})}
						<circle
							cx={button.cx}
							cy={button.cy}
							r={11 + button.pulse * 3}
							fill="none"
							stroke={action}
							strokeWidth={1}
							opacity={stopped ? 0 : (1 - button.pulse) * 0.6}
						/>
						<rect
							x={button.cx - button.size / 2}
							y={button.cy - button.size / 2}
							width={button.size}
							height={button.size}
							rx={button.radius}
							fill={action}
						/>
					</g>

					{/* Each piece leaves the phone and is written out where it lands. */}
					{rough.map((row, k) => {
						if (t < LAUNCH(k)) return null;
						const fly = clamp(spring(t, LAUNCH(k), 1.6, 0.9));
						const landed = t > LAUNCH(k) + 0.55;
						const px = lerp(PHONE.x + PHONE.w - 6, X0, fly);
						const py = lerp(PHONE.y + 60, row.top - 2, fly);
						const typed = smooth((t - LAUNCH(k) - 0.55) / 0.7);
						const leave =
							t > SWEEP[0] ? 1 - smooth((sweepK - k / ROWS) * 5) : 1;
						const merge = smooth((t - STOP_AT - 0.3) / 0.6);
						return (
							<g key={`r${row.top}`} opacity={leave}>
								{landed ? (
									<path
										d={`M ${X0} ${row.top - 3} l 6 3.5 l -6 3.5 z`}
										fill={muted}
										opacity={1 - merge}
									/>
								) : (
									<rect
										x={px}
										y={py}
										width={14}
										height={9}
										fill={surface}
										stroke={action}
										strokeWidth={1.2}
									/>
								)}
								{landed && (
									<g style={{ clipPath: `inset(0 ${(1 - typed) * 100}% 0 0)` }}>
										{row.words.map((w) =>
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
								)}
							</g>
						);
					})}

					{/* One recording once the conversation ends, heard again from start to end. */}
					{strip.map((h, i) => {
						const x = X0 + (i / (BARS - 1)) * (X1 - X0);
						const grow = spring(t, STOP_AT + 0.4 + (i / BARS) * 0.8, 2.4);
						const heard =
							sweeping || t >= SWEEP[1]
								? smooth((sweepX - x) / 10) *
									(1 - smooth((t - SWEEP[1] - 0.4) / 0.6))
								: 0;
						const hh = h * grow;
						return (
							<rect
								key={`s${x}`}
								x={x - 1.25}
								y={STRIP_Y - hh}
								width={2.5}
								height={hh * 2}
								fill={heard > 0.01 ? action : text}
								opacity={0.7 + heard * 0.3}
							/>
						);
					})}
					<line
						x1={sweepX}
						x2={sweepX}
						y1={STRIP_Y - 11}
						y2={STRIP_Y + 11}
						stroke={action}
						strokeWidth={2}
						opacity={
							smooth((t - SWEEP[0]) / 0.2) * (1 - smooth((t - SWEEP[1]) / 0.2))
						}
					/>

					{/* Clean paragraphs, line by line, with the key terms put in place. */}
					{clean.sentences.map((s, i) =>
						sentenceBoxes(s).map((b) => (
							<rect
								key={`h${s[0]}-${b.y}`}
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
						const k = spring(t, CLEAN_AT + l * 0.09, 1.6);
						if (k <= 0) return null;
						return (
							<g
								key={`l${line[0]?.y}`}
								opacity={clamp(k)}
								transform={`translate(0 ${(1 - k) * 5})`}
							>
								{line.map((w) => {
									const term = TERM_WORDS.indexOf(clean.words.indexOf(w));
									const placed =
										term >= 0
											? smooth((t - TERMS_AT - 0.75 - term * 0.25) / 0.2)
											: 0;
									return (
										<rect
											key={`${w.x}`}
											x={w.x}
											y={w.y}
											width={w.w * clamp(k * 1.2)}
											height={4}
											fill={placed > 0.5 ? action : text}
											opacity={term >= 0 ? 0.25 + placed * 0.75 : 0.8}
										/>
									);
								})}
							</g>
						);
					})}
					{/* The project's key terms: a tag under the phone, each copy flying to its word. */}
					{termShow > 0.01 && (
						<g opacity={termShow}>
							<rect
								x={TERM_CHIP.x}
								y={TERM_CHIP.y}
								width={TERM_CHIP.w}
								height={TERM_CHIP.h}
								fill={surface}
								stroke={action}
								strokeWidth={1.2}
							/>
							<circle
								cx={TERM_CHIP.x + 7}
								cy={TERM_CHIP.y + TERM_CHIP.h / 2}
								r={1.8}
								fill={action}
							/>
							<rect
								x={TERM_CHIP.x + 13}
								y={TERM_CHIP.y + 5}
								width={30}
								height={4}
								fill={action}
							/>
							{TERM_WORDS.map((wi, n) => {
								const w = clean.words[wi] as Word;
								const fly = spring(t, TERMS_AT + 0.35 + n * 0.25, 1.5, 0.9);
								if (fly <= 0 || fly > 0.98) return null;
								return (
									<rect
										key={`f${wi}`}
										x={lerp(TERM_CHIP.x + 13, w.x, fly)}
										y={lerp(TERM_CHIP.y + 5, w.y, fly)}
										width={lerp(30, w.w, fly)}
										height={4}
										fill={action}
									/>
								);
							})}
						</g>
					)}

					{/* Playing one sentence: its place in the recording. */}
					{now >= 0 && (
						<line
							x1={nowX}
							x2={nowX}
							y1={STRIP_Y - 11}
							y2={STRIP_Y + 11}
							stroke={action}
							strokeWidth={2}
							opacity={smooth((t - 15.3) / 0.3)}
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
								stroke={surface}
								strokeWidth={1.2}
								strokeLinejoin="round"
							/>
						</g>
					)}
				</g>
			</svg>
			{lines && (
				<Text
					size="sm"
					mt={6}
					h="3em"
					style={{ opacity: caption.opacity * out }}
					data-testid="improve-transcript-line"
				>
					{lines[caption.scene]}
				</Text>
			)}
		</div>
	);
}

/** The loop, from the start each time it is shown; still on the clean result for reduced motion. */
export function ImproveTranscriptAnimation() {
	const reduced = useReducedMotion();
	const [t, setT] = useState(reduced ? 14 : 0);
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
	const lines = [
		translate`While people talk, the text appears piece by piece.`,
		translate`When the conversation ends, we listen to the whole recording again.`,
		translate`Names and key terms are spelled right, and the text is cleaned up.`,
		translate`Click a sentence to hear it from there.`,
	];
	return <ImproveTranscriptFrame t={t} lines={lines} />;
}
