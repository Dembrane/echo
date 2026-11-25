import { t as translate } from "@lingui/core/macro";
// Explainer loop: many conversations go in, one report comes out. Every value is a function of t.
import { CARD, ConvCard, litBy, span } from "./cast";
import { C, clamp, type Loop, lerp, smooth, spring } from "./kit";

type Box = { x: number; y: number; s: number };

/** One pill bar of text, revealed left to right by k; grey unless a person's own words. */
function Pill({
	x,
	y,
	w,
	k = 1,
	h = 4,
	fill = C.muted,
	o = 0.6,
}: {
	x: number;
	y: number;
	w: number;
	k?: number;
	h?: number;
	fill?: string;
	o?: number;
}) {
	const ww = w * clamp(k);
	if (ww < 0.5) return null;
	return (
		<rect
			x={x}
			y={y}
			width={ww}
			height={h}
			rx={Math.min(h, ww) / 2}
			fill={fill}
			opacity={o * smooth(ww / h)}
		/>
	);
}

/** dembrane writing: the one blue caret, at (x, y) of the line it is on. */
function Pen({ x, y, o }: { x: number; y: number; o: number }) {
	if (o < 0.01) return null;
	return (
		<line
			x1={x}
			x2={x}
			y1={y - 3}
			y2={y + 7}
			stroke={C.action}
			strokeWidth={2}
			strokeLinecap="round"
			opacity={o}
		/>
	);
}

/** Grows a group in about its centre: scale from the spring, opacity eased in. */
function Grow({
	cx,
	cy,
	t,
	t0,
	from = 0.8,
	freq = 1.8,
	children,
}: {
	cx: number;
	cy: number;
	t: number;
	t0: number;
	from?: number;
	freq?: number;
	children: React.ReactNode;
}) {
	if (t <= t0) return null;
	const s = lerp(from, 1, spring(t, t0, freq));
	return (
		<g
			opacity={smooth((t - t0) / 0.3)}
			transform={`translate(${cx} ${cy}) scale(${s}) translate(${-cx} ${-cy})`}
		>
			{children}
		</g>
	);
}

// Beat 1: four conversations spread out. Beats 2 to 4: the same four stacked at the left.
const SPREAD: Box[] = [0, 1, 2, 3].map((i) => ({
	s: 1.5,
	x: 64 + (i % 2) * 136,
	y: 36 + Math.floor(i / 2) * 62,
}));
// Cards 0 and 2 were verified by their table: they carry the approved outcome.
const STACK: Box[] = [6, 56, 86, 136].map((y) => ({ s: 1.1, x: 12, y }));
const VERIFIED = [0, 2];
const CARD_W = CARD.w * 1.1;
const CARD_H = CARD.h * 1.1;
const REPORT = { h: 160, w: 188, x: 160, y: 8 };
const RX = REPORT.x + 14;
const FULL = REPORT.x + REPORT.w - 14 - RX;
const lerpBox = (a: Box, b: Box, k: number): Box => ({
	s: lerp(a.s, b.s, k),
	x: lerp(a.x, b.x, k),
	y: lerp(a.y, b.y, k),
});

// Timeline (seconds). Beat starts: 0.2, 4, 8, 12; everything leaves from 15.4.
const CARD_IN = (i: number) => 0.2 + i * 0.4;
const STACK_AT = 4.0;
const REPORT_IN = 4.85;
// The scan reads the four conversations top to bottom, settles, and only then do links and writing begin.
const SCAN_A = 5.2;
const SCAN_B = 6.8;
const SCAN_SETTLE = 7.0;
const SCAN_FADE = 0.5;
const WRITE_AT = 7.5;
const OUTCOME_IN = 4.9;
const TRACE_AT = 12.95;
const LINK_IN = (i: number) => 6.9 + i * 0.12;
const LINKS_OUT = 8.0;
const DIM_AT = 8.0;
const REFLOW_AT = 12.1;
const QUOTE_IN = [12.75, 13.7];
const OUT = 15.4;

/** A line of the report: where it sits before and after the quotes make room, and how it looks. */
type Line = {
	kind: "title" | "q" | "a";
	w: number;
	y3: number;
	y4: number | null;
};
const LINES: Line[] = [
	{ kind: "title", w: FULL * 0.75, y3: 19, y4: 19 },
	{ kind: "q", w: 78, y3: 40, y4: 37 },
	{ kind: "a", w: FULL, y3: 51, y4: 47 },
	{ kind: "a", w: FULL * 0.7, y3: 59, y4: 55 },
	{ kind: "q", w: 96, y3: 78, y4: 90 },
	{ kind: "a", w: FULL * 0.94, y3: 89, y4: 100 },
	{ kind: "a", w: FULL * 0.58, y3: 97, y4: 108 },
	{ kind: "q", w: 70, y3: 116, y4: 124 },
	{ kind: "a", w: FULL * 0.88, y3: 127, y4: 134 },
	// The last answer gives its place to the second quote.
	{ kind: "a", w: FULL * 0.4, y3: 135, y4: null },
];
const lineH = (l: Line) => (l.kind === "title" ? 6 : l.kind === "q" ? 5 : 4);

/** When each report line is written: the title and first question in beat 2, the rest in beat 3. */
const SPEED = 520;
const WRITE: { a: number; d: number }[] = (() => {
	const out: { a: number; d: number }[] = [];
	let t = WRITE_AT;
	for (const [i, l] of LINES.entries()) {
		if (i === 2) t = 8.7;
		else if (i > 0) t += l.kind === "q" ? 0.28 : 0.1;
		const d = Math.max(0.22, l.w / (l.kind === "a" ? SPEED : SPEED * 0.6));
		out.push({ a: t, d });
		t += d;
	}
	return out;
})();
const typed = (t: number, i: number) => clamp((t - WRITE[i]!.a) / WRITE[i]!.d);

/** Where the caret is at t: on the edge of the line being written, gliding to the next line between. */
function caretAt(t: number, reflow: number, yOf: (i: number) => number) {
	let i = 0;
	for (let j = 0; j < WRITE.length; j++) if (t >= WRITE[j]!.a) i = j;
	const w = WRITE[i]!;
	const l = LINES[i]!;
	const edge = (j: number) => RX + LINES[j]!.w * typed(t, j) + 4;
	const end = w.a + w.d;
	const next = WRITE[i + 1];
	let x = edge(i);
	let y = yOf(i) + (lineH(l) - 4) / 2;
	if (next && t > end && next.a - end < 1) {
		const g = smooth((t - end) / (next.a - end));
		x = lerp(x, RX + 4, g);
		y = lerp(y, yOf(i + 1) + (lineH(LINES[i + 1]!) - 4) / 2, g);
	}
	const o =
		smooth((t - (WRITE_AT - 0.2)) / 0.3) *
		(1 -
			smooth(
				(t - (WRITE[WRITE.length - 1]!.a + WRITE[WRITE.length - 1]!.d + 0.15)) /
					0.35,
			)) *
		(1 - reflow);
	return { o, x, y };
}

/** A person's own words, quoted: a small graphite pull-quote under a rounded rule, drawn top down. */
function Quote({
	y,
	w1,
	w2,
	t,
	t0,
}: {
	y: number;
	w1: number;
	w2: number;
	t: number;
	t0: number;
}) {
	if (t <= t0) return null;
	const rule = spring(t, t0, 2.2);
	return (
		<g>
			<line
				x1={RX + 6}
				x2={RX + 6}
				y1={y}
				y2={y + 12 * clamp(rule, 0, 1.04)}
				stroke={C.text}
				strokeWidth={2}
				strokeLinecap="round"
				opacity={smooth((t - t0) / 0.2)}
			/>
			<Pill
				x={RX + 14}
				y={y}
				w={w1}
				k={(t - t0 - 0.25) / 0.45}
				fill={C.text}
				o={0.8}
			/>
			<Pill
				x={RX + 14}
				y={y + 8}
				w={w2}
				k={(t - t0 - 0.62) / 0.35}
				fill={C.text}
				o={0.8}
			/>
		</g>
	);
}

export const report: Loop = {
	draw: (t) => {
		// Conversations: grow in spread out, then slide into a stack, then step back.
		const dimK = smooth((t - DIM_AT) / 0.6);
		// The left column slides straight into place; the right column first drops to its row, then slides in along a free lane.
		const boxes = SPREAD.map((a, i) => {
			const k = spring(t, STACK_AT, 1.3, 0.86);
			const kx = i % 2 ? spring(t, STACK_AT + 0.45, 1.3, 0.86) : k;
			const b = lerpBox(a, STACK[i]!, k);
			return { ...b, x: lerp(a.x, STACK[i]!.x, kx) };
		});
		// The scan: one blue line moving down the stack, then it and what it lit ease out together.
		const scanY = lerp(4, 172, smooth((t - SCAN_A) / (SCAN_B - SCAN_A)));
		const scanHold = smooth((t - SCAN_SETTLE) / SCAN_FADE);
		const scanO = smooth((t - SCAN_A) / 0.25) * (1 - scanHold);
		const trace = span(t, TRACE_AT, 14.4, 0.3, 0.4);
		const cards = boxes.map((b, i) => {
			const at = SPREAD[i]!;
			const st = STACK[i]!;
			const verified = VERIFIED.includes(i);
			const oK = verified ? smooth((t - OUTCOME_IN - i * 0.12) / 0.4) : 0;
			const cardLit = litBy(scanY, st.y + CARD_H / 2, t, SCAN_SETTLE);
			// The scan reads the approved outcome too, as it passes.
			const outLit = litBy(scanY, st.y + CARD_H + 10, t, SCAN_SETTLE);
			const faded = dimK * (i === 0 ? 1 - trace : 1);
			return (
				<Grow
					key={`card-${at.x}-${at.y}`}
					cx={at.x + (CARD.w * at.s) / 2}
					cy={at.y + (CARD.h * at.s) / 2}
					t={t}
					t0={CARD_IN(i)}
					from={0.82}
					freq={1.9}
				>
					<g transform={`translate(${b.x} ${b.y}) scale(${b.s})`}>
						<ConvCard
							x={0}
							y={0}
							k={1}
							lit={cardLit}
							faded={faded}
							picked={i === 0 ? trace : 0}
							outcome={oK}
						/>
						{oK > 0.99 && outLit > 0.01 && (
							<g fill={C.action} opacity={outLit * (1 - faded * 0.75)}>
								<rect x={14} y={CARD.h + 7} width={24} height={2.6} rx={1.3} />
								<rect
									x={14}
									y={CARD.h + 11.4}
									width={16}
									height={2.6}
									rx={1.3}
								/>
							</g>
						)}
					</g>
				</Grow>
			);
		});

		// The caret in beat 1, writing each conversation as it arrives.
		const pens = SPREAD.map((at, i) => {
			const a = CARD_IN(i) + 0.3;
			const end = i === 3 ? 3.45 : a + 0.35;
			return (
				<Pen
					key={`pen-${at.x}-${at.y}`}
					x={at.x + 22 * at.s + 22 * at.s + 4}
					y={at.y + 14 * at.s}
					o={span(t, a, end, 0.15, 0.2)}
				/>
			);
		});

		// Links from every conversation to the one report, drawn along their curve.
		const linksOut = 1 - smooth((t - LINKS_OUT) / 0.5);
		const links = STACK.map((b, i) => {
			const k = smooth((t - LINK_IN(i)) / 0.6);
			if (k <= 0 || linksOut <= 0) return null;
			const y0 = b.y + CARD_H / 2;
			return (
				<path
					key={`link-${b.y}`}
					d={`M${b.x + CARD_W + 4} ${y0} Q${REPORT.x - 8} ${y0} ${REPORT.x - 4} 88`}
					pathLength={1}
					strokeDasharray="1 1"
					strokeDashoffset={1 - k}
					opacity={0.7 * linksOut}
				/>
			);
		});

		// The report: lines written in order, then shifted down to make room for two quotes.
		const reflow = spring(t, REFLOW_AT, 1.4, 0.86);
		const yOf = (i: number) => {
			const l = LINES[i]!;
			return lerp(l.y3, l.y4 ?? l.y3, reflow);
		};
		const pen2 = caretAt(t, clamp(smooth((t - REFLOW_AT + 0.4) / 0.3)), yOf);
		const body = LINES.map((l, i) => {
			const k = typed(t, i);
			const gone = l.y4 === null ? 1 - smooth((t - REFLOW_AT) / 0.35) : 1;
			const o = l.kind === "a" ? 0.6 : 0.85;
			return (
				<Pill
					key={`line-${l.y3}`}
					x={RX}
					y={yOf(i)}
					w={l.w}
					h={lineH(l)}
					k={k}
					o={o * gone}
				/>
			);
		});

		// Everything has gone a little before the loop wraps, so the last frame equals the first.
		return (
			<g opacity={1 - smooth((t - OUT - 0.05) / 0.45)}>
				{cards}
				{scanO > 0.01 && (
					<line
						x1={STACK[0]!.x - 2}
						x2={STACK[0]!.x + CARD_W + 2}
						y1={scanY}
						y2={scanY}
						stroke={C.action}
						strokeWidth={2}
						strokeLinecap="round"
						opacity={scanO}
					/>
				)}
				<g fill="none" stroke={C.muted} strokeWidth={1.2} strokeLinecap="round">
					{links}
				</g>
				<Grow
					cx={REPORT.x + REPORT.w / 2}
					cy={REPORT.y + REPORT.h / 2}
					t={t}
					t0={REPORT_IN}
					from={0.9}
					freq={1.6}
				>
					<rect
						x={REPORT.x}
						y={REPORT.y}
						width={REPORT.w}
						height={REPORT.h}
						rx={6}
						fill={C.surface}
						stroke={C.quiet}
						strokeWidth={1}
					/>
					{body}
					<Quote
						y={65}
						w1={FULL * 0.62}
						w2={FULL * 0.4}
						t={t}
						t0={QUOTE_IN[0]!}
					/>
					<Quote
						y={144}
						w1={FULL * 0.56}
						w2={FULL * 0.32}
						t={t}
						t0={QUOTE_IN[1]!}
					/>
				</Grow>
				{trace > 0.01 && (
					<path
						d={`M${RX + 2} 69 Q${RX - 50} 66 ${STACK[0]!.x + CARD_W + 3} ${STACK[0]!.y + CARD_H / 2}`}
						fill="none"
						stroke={C.action}
						strokeWidth={1.5}
						strokeLinecap="round"
						pathLength={1}
						strokeDasharray="1 1"
						strokeDashoffset={1 - smooth((t - TRACE_AT - 0.1) / 0.7)}
						opacity={trace}
					/>
				)}
				{pens}
				<Pen x={pen2.x} y={pen2.y} o={pen2.o} />
			</g>
		);
	},
	lines: () => [
		translate`Every conversation becomes a transcript.`,
		translate`One report covers all of them.`,
		translate`Each question gets its own answer.`,
		translate`Quotes show people's own words.`,
	],
	out: OUT,
	scenes: [0.2, 4, 8, 12],
	seconds: 16,
};
export default report;
