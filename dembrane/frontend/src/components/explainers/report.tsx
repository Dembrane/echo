import { t as translate } from "@lingui/core/macro";
// Explainer loop: many conversations go in, one report comes out. Every value is a function of t.
import { C, clamp, type Loop, lerp, smooth, spring } from "./kit";

type Box = { x: number; y: number; w: number; h: number };

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

const W1 = [0.92, 0.78, 0.86, 0.72];
const W2 = [0.55, 0.66, 0.48, 0.6];

/** A conversation, the same shape in every loop: rounded card, a head at its left, two short grey bars. */
function convo(b: Box, i: number) {
	const s = b.h / 34;
	const bx = b.x + 30 * s;
	const room = b.x + b.w - 12 - bx;
	return {
		bx,
		hx: b.x + 15 * s,
		hy: b.y + b.h / 2 - 5 * s,
		s,
		w1: room * W1[i]!,
		w2: room * W2[i]!,
		y1: b.y + b.h / 2 - 6,
		y2: b.y + b.h / 2 + 3,
	};
}
function Conversation({
	b,
	i,
	o = 1,
	k1 = 1,
	k2 = 1,
	scanY = -1,
	scanHold = 0,
}: {
	b: Box;
	i: number;
	o?: number;
	k1?: number;
	k2?: number;
	scanY?: number;
	scanHold?: number;
}) {
	const c = convo(b, i);
	// A bar turns blue the moment the scan crosses it, and eases back to grey as the scan settles.
	const lit = (y: number) => smooth((scanY - y) / 12) * (1 - scanHold);
	return (
		<g opacity={o}>
			<rect
				x={b.x}
				y={b.y}
				width={b.w}
				height={b.h}
				rx={6}
				fill={C.surface}
				stroke={C.quiet}
				strokeWidth={1}
			/>
			<g fill="none" stroke={C.text} strokeWidth={1.3} strokeLinecap="round">
				<circle cx={c.hx} cy={c.hy} r={4.2 * c.s} />
				<path
					d={`M${c.hx - 7.5 * c.s} ${c.hy + 14 * c.s} Q${c.hx} ${c.hy + 3.5 * c.s} ${c.hx + 7.5 * c.s} ${c.hy + 14 * c.s}`}
				/>
			</g>
			<Pill x={c.bx} y={c.y1} w={c.w1} k={k1} o={0.6 * (1 - lit(c.y1))} />
			<Pill x={c.bx} y={c.y2} w={c.w2} k={k2} o={0.6 * (1 - lit(c.y2))} />
			<Pill
				x={c.bx}
				y={c.y1}
				w={c.w1}
				k={k1}
				fill={C.action}
				o={0.9 * lit(c.y1)}
			/>
			<Pill
				x={c.bx}
				y={c.y2}
				w={c.w2}
				k={k2}
				fill={C.action}
				o={0.9 * lit(c.y2)}
			/>
		</g>
	);
}

// Beat 1: four conversations spread out. Beats 2 to 4: the same four stacked at the left.
const SPREAD: Box[] = [0, 1, 2, 3].map((i) => ({
	h: 44,
	w: 136,
	x: 36 + (i % 2) * 152,
	y: 34 + Math.floor(i / 2) * 60,
}));
const STACK: Box[] = [0, 1, 2, 3].map((i) => ({
	h: 34,
	w: 104,
	x: 12,
	y: 8 + i * 42,
}));
const REPORT: Box = { h: 160, w: 188, x: 160, y: 8 };
const RX = REPORT.x + 14;
const FULL = REPORT.x + REPORT.w - 14 - RX;
const lerpBox = (a: Box, b: Box, k: number): Box => ({
	h: lerp(a.h, b.h, k),
	w: lerp(a.w, b.w, k),
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
	{ kind: "title", w: 92, y3: 20, y4: 20 },
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
const lineH = (l: Line) => (l.kind === "title" ? 7 : l.kind === "q" ? 5 : 4);

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
		const dim = lerp(1, 0.25, smooth((t - DIM_AT) / 0.6));
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
		const cards = boxes.map((b, i) => {
			const a = CARD_IN(i);
			const last = i === 3;
			const k1 = (t - a - 0.3) / 0.45;
			const k2 = last ? (t - 2.05) / 1.25 : (t - a - 0.6) / 0.35;
			const at = SPREAD[i]!;
			return (
				<Grow
					key={`card-${SPREAD[i]!.x}-${SPREAD[i]!.y}`}
					cx={at.x + at.w / 2}
					cy={at.y + at.h / 2}
					t={t}
					t0={a}
					from={0.82}
					freq={1.9}
				>
					<Conversation
						b={b}
						i={i}
						o={dim}
						k1={k1}
						k2={k2}
						scanY={scanY}
						scanHold={scanHold}
					/>
				</Grow>
			);
		});

		// The caret in beat 1, writing the last conversation's second line.
		const c3 = convo(boxes[3]!, 3);
		const pen1 = {
			o: smooth((t - 1.85) / 0.25) * (1 - smooth((t - 3.45) / 0.35)),
			x: c3.bx + c3.w2 * clamp((t - 2.05) / 1.25) + 4,
			y: c3.y2,
		};

		// Links from every conversation to the one report, drawn along their curve.
		const linksOut = 1 - smooth((t - LINKS_OUT) / 0.5);
		const links = STACK.map((b, i) => {
			const k = smooth((t - LINK_IN(i)) / 0.6);
			if (k <= 0 || linksOut <= 0) return null;
			const y0 = b.y + b.h / 2;
			return (
				<path
					key={`link-${b.y}`}
					d={`M${b.x + b.w + 4} ${y0} Q${REPORT.x - 8} ${y0} ${REPORT.x - 4} 88`}
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

		const pen = pen1.o > 0.01 ? pen1 : pen2;
		// Everything has gone a little before the loop wraps, so the last frame equals the first.
		return (
			<g opacity={1 - smooth((t - OUT - 0.05) / 0.45)}>
				{cards}
				{scanO > 0.01 && (
					<line
						x1={STACK[0]!.x - 2}
						x2={STACK[0]!.x + STACK[0]!.w + 2}
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
				<Pen x={pen.x} y={pen.y} o={pen.o} />
			</g>
		);
	},
	lines: () => [
		translate`Every conversation, written down.`,
		translate`One report across all of them.`,
		translate`What came up, question by question.`,
		translate`With quotes in people's own words.`,
	],
	out: OUT,
	scenes: [0.2, 4, 8, 12],
	seconds: 16,
};
export default report;
