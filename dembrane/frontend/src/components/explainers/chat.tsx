import { t as translate } from "@lingui/core/macro";
// Every value is a pure function of t, so any frame renders on its own and the loop is exact.
import { C, Cursor, clamp, type Loop, lerp, smooth, spring } from "./kit";

// Conversations sit in two staggered columns so every card has a clear path to the answer on the right.
const CW = 70;
const CH = 30;
const COLS = [16, 96];
const TOPS = [22, 44];
const PITCH = 42;
const CARDS = [0, 1, 2].flatMap((r) =>
	[0, 1].map((c) => ({ c, r, x: COLS[c]!, y: TOPS[c]! + r * PITCH })),
);
const id = (c: number, r: number) => r * 2 + c;
const PICKED = [id(0, 0), id(1, 1), id(0, 2)];
const FAINT = [id(1, 0), id(1, 2)];

const ANS = { h: 92, w: 132, x: 214, y: 64 };
const JOIN = { x: ANS.x, y: ANS.y + ANS.h / 2 };
const Q = { h: 26, w: 104, x: 214, y: 20 };

// Beat 0: the conversations grow in one after another.
const CARD_AT = (i: number) => 0.25 + i * 0.2;
// Beat 1: the pointer comes in, presses each pick in turn, then the rest step back.
const MOVE_AT = [4.25, 5.2, 6.15];
const PRESS_AT = MOVE_AT.map((m) => m + 0.6);
const FADE_AT = 7.0;
const CURSOR_OUT = 7.75;
// Beat 2: the asker, then the bubble, then the question typed in.
const ASKER_AT = 8.2;
const BUBBLE_AT = 8.55;
const TYPE = [9.05, 10.65] as const;
// Beat 3: dembrane reads the picks: a blue line crosses the cards and lights their bars, then they settle.
const SCAN = [10.9, 12.5] as const;
const SCAN_X = [10, 176] as const;
const SETTLE = [12.5, 13.0] as const;
// Beat 4: the answer card, then (the scan has settled) the links drawn into it, then its lines written.
const ANSWER_AT = 12.7;
const LINKS = [13.1, 13.9] as const;
const FAINT_LINKS = [13.3, 14.0] as const;
const ROWS_AT = 13.7;

const step = (t: number, a: number, d: number) => smooth((t - a) / d);

/** Where the scan line is, left to right across the conversations. */
const scanX = (t: number) =>
	lerp(SCAN_X[0], SCAN_X[1], smooth((t - SCAN[0]) / (SCAN[1] - SCAN[0])));
/** How blue a bar at x is: lit as the line crosses it, held until the scan settles, then back to grey. */
const lit = (t: number, x: number) =>
	smooth((scanX(t) - x) / 12) * (1 - step(t, SETTLE[0], SETTLE[1] - SETTLE[0]));

function Person({
	cx,
	cy,
	s = 1,
	opacity = 1,
}: {
	cx: number;
	cy: number;
	s?: number;
	opacity?: number;
}) {
	return (
		<g
			opacity={opacity}
			fill="none"
			stroke={C.text}
			strokeWidth={1.3}
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<circle cx={cx} cy={cy - 3 * s} r={3.6 * s} />
			<path
				d={`M ${cx - 6.5 * s} ${cy + 8 * s} Q ${cx} ${cy + 1 * s} ${cx + 6.5 * s} ${cy + 8 * s}`}
			/>
		</g>
	);
}

/** A pill typed in from the left: k is how much of it is written. */
function Pill({
	x,
	y,
	w,
	k = 1,
	h = 4,
	fill,
	opacity,
	blue = 0,
}: {
	x: number;
	y: number;
	w: number;
	k?: number;
	h?: number;
	fill: string;
	opacity: number;
	blue?: number;
}) {
	const ww = w * clamp(k);
	if (ww < 0.5) return null;
	const grow = clamp(ww / h);
	return (
		<>
			<rect
				x={x}
				y={y}
				width={Math.max(ww, h)}
				height={h}
				rx={h / 2}
				fill={fill}
				opacity={opacity * grow * (1 - blue)}
			/>
			{blue > 0.01 && (
				<rect
					x={x}
					y={y}
					width={Math.max(ww, h)}
					height={h}
					rx={h / 2}
					fill={C.action}
					opacity={grow * blue}
				/>
			)}
		</>
	);
}

/** A conversation: rounded card, a person at its left, two short grey pills. Grows in, then may be picked or step back. */
function Conversation({ i, t }: { i: number; t: number }) {
	const { x, y } = CARDS[i]!;
	const k = spring(t, CARD_AT(i), 1.6);
	if (k <= 0) return null;
	const w1 = 30 + ((i * 7) % 4) * 3;
	const w2 = 18 + ((i * 5) % 3) * 4;
	const pick = PICKED.indexOf(i);
	const chosen = pick >= 0 ? step(t, PRESS_AT[pick]!, 0.25) : 0;
	const back = pick < 0 ? step(t, FADE_AT, 0.6) : 0;
	const cx = x + CW / 2;
	const cy = y + CH / 2;
	// A small give under the press, settling back with the spring.
	const press =
		pick >= 0
			? 1 -
				0.035 *
					(step(t, PRESS_AT[pick]! - 0.08, 0.08) -
						spring(t, PRESS_AT[pick]! + 0.05, 2.2))
			: 1;
	const scale = (0.9 + 0.1 * k) * press;
	const text = (a: number) => step(t, CARD_AT(i) + a, 0.4);
	return (
		<g
			opacity={clamp(k) * lerp(1, 0.25, back)}
			transform={`translate(${cx} ${cy}) scale(${scale}) translate(${-cx} ${-cy})`}
		>
			<rect
				x={x}
				y={y}
				width={CW}
				height={CH}
				rx={6}
				fill={C.surface}
				stroke={C.quiet}
				strokeWidth={1}
			/>
			{chosen > 0 && (
				<rect
					x={x}
					y={y}
					width={CW}
					height={CH}
					rx={6}
					fill="none"
					stroke={C.text}
					strokeWidth={1.6}
					opacity={chosen}
				/>
			)}
			<Person cx={x + 13} cy={y + CH / 2} s={0.9} />
			<Pill
				x={x + 26}
				y={y + 9}
				w={w1}
				k={text(0.25)}
				fill={C.muted}
				opacity={0.7}
				blue={pick >= 0 ? lit(t, x + 26) : 0}
			/>
			<Pill
				x={x + 26}
				y={y + 17}
				w={w2}
				k={text(0.4)}
				fill={C.muted}
				opacity={0.7}
				blue={pick >= 0 ? lit(t, x + 26) : 0}
			/>
		</g>
	);
}

/** dembrane reading: a thin blue line sweeping left to right over the conversations. */
function Scan({ t }: { t: number }) {
	const o = step(t, SCAN[0] - 0.1, 0.25) * (1 - step(t, SCAN[1] - 0.15, 0.3));
	if (o < 0.01) return null;
	const x = scanX(t);
	return (
		<line
			x1={x}
			x2={x}
			y1={14}
			y2={152}
			stroke={C.action}
			strokeWidth={2}
			strokeLinecap="round"
			opacity={o}
		/>
	);
}

/** A curve from a card's right edge into the answer; runs level past the second column, then bends. */
function linkPath(i: number) {
	const { x, y } = CARDS[i]!;
	const ys = y + CH / 2;
	const run = COLS[1]! + CW + 6;
	const start = `M ${x + CW} ${ys}`;
	const level = x + CW < run ? ` H ${run}` : "";
	return `${start}${level} C ${run + 22} ${ys}, ${JOIN.x - 22} ${JOIN.y}, ${JOIN.x} ${JOIN.y}`;
}

/** A link drawn along its own curve, k of the way from the card to the answer. */
function Link({
	i,
	k,
	stroke,
	width,
	opacity = 1,
}: {
	i: number;
	k: number;
	stroke: string;
	width: number;
	opacity?: number;
}) {
	if (k <= 0.001) return null;
	return (
		<path
			d={linkPath(i)}
			pathLength={1}
			strokeDasharray="1 1"
			strokeDashoffset={1 - k}
			stroke={stroke}
			strokeWidth={width}
			opacity={opacity}
		/>
	);
}

/** The pointer: in from below, on to each pick, pressing it, then it rests on the last one and leaves. */
function Pointer({ t }: { t: number }) {
	const target = (i: number) => ({
		x: CARDS[i]!.x + CW - 14,
		y: CARDS[i]!.y + CH - 16,
	});
	let p = { x: 150, y: 190 };
	for (const [n, at] of MOVE_AT.entries()) {
		const k = spring(t, at, 1.5, 0.9);
		const q = target(PICKED[n]!);
		p = { x: lerp(p.x, q.x, k), y: lerp(p.y, q.y, k) };
	}
	const opacity =
		step(t, MOVE_AT[0]! - 0.05, 0.3) * (1 - step(t, CURSOR_OUT, 0.4));
	const press = PRESS_AT.some((a) => t > a - 0.08 && t < a + 0.1);
	return <Cursor x={p.x} y={p.y} opacity={opacity} press={press} />;
}

/** The person's question: the asker, a rounded bubble growing from its left, graphite pills typed in behind a caret. */
function Question({ t }: { t: number }) {
	const asker = spring(t, ASKER_AT, 1.6);
	if (asker <= 0) return null;
	const bubble = spring(t, BUBBLE_AT, 1.5);
	const w = Q.w * bubble;
	const typed = step(t, TYPE[0], TYPE[1] - TYPE[0]);
	const words = [
		{ w: 26, x: 14 },
		{ w: 18, x: 44 },
		{ w: 14, x: 66 },
	];
	const edge = 14 + (80 - 14) * typed;
	// Steady while typing, a slow soft blink once the question is written.
	const blink =
		t < TYPE[1] ? 1 : 0.55 + 0.45 * Math.cos((t - TYPE[1]) * Math.PI * 1.6);
	const caret = step(t, TYPE[0] - 0.25, 0.25) * blink;
	const pcx = Q.x + Q.w + 16;
	const pcy = Q.y + Q.h / 2;
	return (
		<g>
			<g
				opacity={clamp(asker)}
				transform={`translate(${pcx} ${pcy + 4}) scale(${0.85 + 0.15 * asker}) translate(${-pcx} ${-(pcy + 4)})`}
			>
				<Person cx={pcx} cy={pcy} />
			</g>
			{w > 1 && (
				<g opacity={clamp(bubble * 2)}>
					<rect
						x={Q.x}
						y={Q.y}
						width={Math.max(w, Q.h)}
						height={Q.h}
						rx={Q.h / 2}
						fill={C.surface}
						stroke={C.quiet}
						strokeWidth={1}
					/>
					{words.map((wd) => (
						<Pill
							key={wd.x}
							x={Q.x + wd.x}
							y={Q.y + 11}
							w={wd.w}
							k={(edge - wd.x) / wd.w}
							fill={C.text}
							opacity={0.85}
						/>
					))}
					{caret > 0.01 && (
						<line
							x1={Q.x + edge + 7}
							x2={Q.x + edge + 7}
							y1={Q.y + 7}
							y2={Q.y + 19}
							stroke={C.text}
							strokeWidth={1.4}
							strokeLinecap="round"
							opacity={caret}
						/>
					)}
				</g>
			)}
		</g>
	);
}

/** dembrane's answer: a hairline card that grows in, then grey lines written once the links reach it. */
function Answer({ t }: { t: number }) {
	const k = spring(t, ANSWER_AT, 1.5);
	if (k <= 0) return null;
	const rows = [104, 92, 112, 84, 60];
	const cx = ANS.x + ANS.w / 2;
	const cy = ANS.y + ANS.h / 2;
	return (
		<g
			opacity={clamp(k)}
			transform={`translate(${cx} ${cy}) scale(${0.92 + 0.08 * k}) translate(${-cx} ${-cy})`}
		>
			<rect
				x={ANS.x}
				y={ANS.y}
				width={ANS.w}
				height={ANS.h}
				rx={6}
				fill={C.surface}
				stroke={C.quiet}
				strokeWidth={1}
			/>
			{rows.map((w, r) => (
				<Pill
					key={`row-${w}`}
					x={ANS.x + 12}
					y={ANS.y + 16 + r * 14}
					w={w}
					k={step(t, ROWS_AT + r * 0.28, 0.5)}
					fill={C.muted}
					opacity={0.7}
				/>
			))}
		</g>
	);
}

export const chat: Loop = {
	draw: (t) => {
		const blue = step(t, LINKS[0], LINKS[1] - LINKS[0]);
		const grey = step(t, FAINT_LINKS[0], FAINT_LINKS[1] - FAINT_LINKS[0]);
		// Reaches zero just before the loop's last frame, so the last frame matches the first exactly.
		const gone = 1 - step(t, 15.4, 0.5);
		return (
			<g opacity={gone}>
				{/* The answer leans on the picks (blue, the one dembrane thing) and only lightly on two others. */}
				<g fill="none" strokeLinecap="round">
					{FAINT.map((i) => (
						<Link
							key={i}
							i={i}
							k={grey}
							stroke={C.muted}
							width={1}
							opacity={0.45}
						/>
					))}
					{PICKED.map((i) => (
						<Link key={i} i={i} k={blue} stroke={C.action} width={1.8} />
					))}
				</g>
				{CARDS.map((card) => (
					<Conversation
						key={`${card.c}-${card.r}`}
						i={id(card.c, card.r)}
						t={t}
					/>
				))}
				<Scan t={t} />
				<Question t={t} />
				<Answer t={t} />
				<Pointer t={t} />
			</g>
		);
	},
	lines: () => [
		translate`All your conversations in one place.`,
		translate`Pick the ones that matter.`,
		translate`Ask your question.`,
		translate`Answers lean on your picks.`,
	],
	out: 15.4,
	scenes: [0, 4, 8, 12],
	seconds: 16,
};
export default chat;
