import { t as translate } from "@lingui/core/macro";
import { C, Cursor, clamp, type Loop, lerp, smooth, spring } from "./kit";

// Beats: 0 conversations, 1 dembrane finds the ideas in them, 2 related ideas gather, 3 open one for its quotes.
// Every value is a pure function of t; the loop starts and ends empty.

const OUT = 15.35;

/** Grow in around (cx, cy): scale from a little smaller with a spring, opacity eases in. */
const grow = (
	t: number,
	t0: number,
	cx: number,
	cy: number,
	from = 0.82,
	freq = 1.8,
) => {
	const k = spring(t, t0, freq);
	const s = lerp(from, 1, k);
	return {
		op: smooth((t - t0) / 0.3),
		transform: `translate(${cx} ${cy}) scale(${s}) translate(${-cx} ${-cy})`,
	};
};

const Pill = ({
	x,
	y,
	w,
	k = 1,
	fill = C.muted,
	op = 0.7,
	blue = 0,
}: {
	x: number;
	y: number;
	w: number;
	k?: number;
	fill?: string;
	op?: number;
	blue?: number;
}) => {
	const ww = w * clamp(k);
	if (ww < 0.5) return null;
	// A bar narrower than its height would read as a dot, so the first few pixels fade in instead.
	const fade = clamp(ww / 6);
	const b = clamp(blue);
	return (
		<g>
			<rect
				x={x}
				y={y}
				width={Math.max(ww, 4)}
				height={4}
				rx={2}
				fill={fill}
				opacity={op * fade * (1 - b)}
			/>
			{b > 0.001 && (
				<rect
					x={x}
					y={y}
					width={Math.max(ww, 4)}
					height={4}
					rx={2}
					fill={C.action}
					opacity={fade * b}
				/>
			)}
		</g>
	);
};

/** A person: circle head over a rounded shoulder arc, graphite. */
const Person = ({ cx, cy, s = 1 }: { cx: number; cy: number; s?: number }) => (
	<g fill="none" stroke={C.text} strokeWidth={1.3} strokeLinecap="round">
		<circle cx={cx} cy={cy} r={4.5 * s} />
		<path
			d={`M ${cx - 8 * s} ${cy + 15 * s} Q ${cx} ${cy + 3 * s} ${cx + 8 * s} ${cy + 15 * s}`}
		/>
	</g>
);

/** A conversation: the shared shape, a rounded card with a head at its left and two grey pill bars. */
const CW = 84;
const CH = 40;
const Conversation = ({
	x,
	y,
	k = 1,
	lit = () => 0,
}: {
	x: number;
	y: number;
	k?: number;
	/** How blue a bar at this x is (0 to 1): the scan lights it as it crosses. */
	lit?: (px: number) => number;
}) => (
	<g>
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
		<Person cx={x + 16} cy={y + 13} s={0.8} />
		<Pill x={x + 30} y={y + 14} w={42} k={k * 1.6} blue={lit(x + 51)} />
		<Pill x={x + 30} y={y + 23} w={28} k={k * 1.6 - 0.6} blue={lit(x + 44)} />
	</g>
);

/** One idea: a small hairline card; ideas of one kind share a bar pattern, so related ones look alike. */
const TW = 34;
const TH = 22;
const patterns: [number, number][][][] = [
	[[[0, 24]], [[0, 12]]],
	[
		[
			[0, 9],
			[13, 11],
		],
		[[0, 24]],
	],
	[[[0, 24]], [[0, 24]]],
];
const Idea = ({
	x,
	y,
	k,
	op = 1,
	blue = 0,
}: {
	x: number;
	y: number;
	k: number;
	op?: number;
	blue?: number;
}) => (
	<g opacity={op}>
		<rect
			x={x - TW / 2}
			y={y - TH / 2}
			width={TW}
			height={TH}
			rx={6}
			fill={C.surface}
			stroke={C.quiet}
			strokeWidth={1}
		/>
		{patterns[k]!.map((row, r) =>
			row.map(([dx, w]) => (
				<Pill
					key={`${r}-${dx}`}
					x={x - 12 + dx}
					y={y - 6 + r * 8}
					w={w}
					blue={blue}
				/>
			)),
		)}
	</g>
);

/** A gentle curved hairline between two points, drawn along its length by k. */
const Curve = ({
	x1,
	y1,
	x2,
	y2,
	bend = 0.25,
	op = 1,
	k = 1,
}: {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	bend?: number;
	op?: number;
	k?: number;
}) => {
	if (k <= 0.001 || op <= 0.001) return null;
	const mx = (x1 + x2) / 2 - (y2 - y1) * bend;
	const my = (y1 + y2) / 2 + (x2 - x1) * bend;
	return (
		<path
			d={`M ${x1} ${y1} Q ${mx} ${my} ${x2} ${y2}`}
			fill="none"
			stroke={C.muted}
			strokeWidth={1.2}
			strokeLinecap="round"
			opacity={0.5 * op}
			pathLength={1}
			strokeDasharray="1 1"
			strokeDashoffset={1 - clamp(k)}
		/>
	);
};

// Beat 0: three conversations grow in, one after another.
const convX = [26, 138, 250];
const CONV_IN = [0.25, 0.75, 1.25];
const CONV_Y0 = 68;
// Beat 1: they settle low, then the blue sweep crosses them and each idea rises out as it passes.
const CONV_Y1 = 122;
const DROP_AT = 4.1;
const SW: [number, number] = [4.7, 7.3];
const SX: [number, number] = [14, 352];
const sweepX = (t: number) =>
	lerp(SX[0], SX[1], smooth((t - SW[0]) / (SW[1] - SW[0])));
/** When the sweep reaches x: the inverse of sweepX, by bisection. */
const sweepAt = (x: number) => {
	let lo = SW[0];
	let hi = SW[1];
	for (let i = 0; i < 40; i++) {
		const mid = (lo + hi) / 2;
		if (sweepX(mid) < x) lo = mid;
		else hi = mid;
	}
	return lo;
};

// Ideas each conversation raised: x, y, kind, conversation, and where each one goes in the neighbourhoods.
// `o` is the order they set off in and `bu` how far each swings out of line (up or down) on the way,
// chosen so no two ideas ever overlap or cross while they gather.
const raised: {
	x: number;
	y: number;
	k: number;
	c: number;
	to: number;
	o: number;
	bu: number;
	at: number;
}[] = [
	{ bu: -16, c: 0, k: 0, o: 6, to: 0, x: 36, y: 80 },
	{ bu: -16, c: 0, k: 1, o: 1, to: 3, x: 68, y: 46 },
	{ bu: -8, c: 0, k: 2, o: 5, to: 6, x: 100, y: 82 },
	{ bu: 0, c: 1, k: 0, o: 2, to: 1, x: 154, y: 82 },
	{ bu: -8, c: 1, k: 2, o: 0, to: 7, x: 196, y: 48 },
	{ bu: -16, c: 2, k: 1, o: 4, to: 5, x: 264, y: 82 },
	{ bu: 0, c: 2, k: 0, o: 3, to: 2, x: 296, y: 48 },
	{ bu: 16, c: 2, k: 1, o: 7, to: 4, x: 330, y: 82 },
].map((p) => ({ ...p, at: sweepAt(p.x) }));

// Beat 2 and 3: the same eight ideas gathered into three neighbourhoods, in a 200 x 160 box.
const placed: { x: number; y: number; k: number }[] = [
	{ k: 0, x: 28, y: 32 },
	{ k: 0, x: 68, y: 22 },
	{ k: 0, x: 46, y: 62 },
	{ k: 1, x: 140, y: 26 },
	{ k: 1, x: 178, y: 44 },
	{ k: 1, x: 150, y: 74 },
	{ k: 2, x: 84, y: 128 },
	{ k: 2, x: 124, y: 142 },
];
const links: [number, number][] = [
	[0, 1],
	[0, 2],
	[3, 4],
	[4, 5],
	[6, 7],
];
const CONV_OUT = 8.05;
// All ideas gather as one movement, a beat apart from left to right, then the links between neighbours draw.
const GATHER_AT = 8.6;
const GATHER_STEP = 0.1;
const LINK_AT = [10.3, 10.55, 10.8, 11.05, 11.3];
const LINK_D = 0.5;

// Beat 3: the map slides left to make room, a pointer opens one idea, the rest fades back, its quotes open beside it.
const SEL = 3;
const SLIDE_AT = 12.05;
const OFF = { x0: 80, x1: 6, y: 8 };
const CURSOR_AT = 12.4;
const PRESS = 13.05;
const FADE = [13.15, 13.55] as const;
const CARD_AT = 13.35;
const CARD = { h: 148, w: 126, x: 226, y: 14 };

const offX = (t: number) => lerp(OFF.x0, OFF.x1, spring(t, SLIDE_AT, 1.1));

/** Where neighbourhood idea i sits at t, and how it shows. */
function idea(t: number, i: number) {
	const ri = raised.findIndex((p) => p.to === i);
	const r = raised[ri]!;
	const target = { x: placed[i]!.x + offX(t), y: placed[i]!.y + OFF.y };
	const g = spring(t, GATHER_AT + r.o * GATHER_STEP, 1.4);
	// Rises a little out of its conversation as it appears.
	const rise = (1 - spring(t, r.at + 0.25, 1.6)) * 10;
	const x = lerp(r.x, target.x, g);
	const y = lerp(r.y + rise, target.y, g) + r.bu * Math.sin(Math.PI * clamp(g));
	const s = lerp(0.6, 1, spring(t, r.at + 0.25, 1.8));
	const op =
		smooth((t - r.at - 0.25) / 0.3) *
		lerp(1, 0.25, i === SEL ? 0 : smooth((t - FADE[0]) / (FADE[1] - FADE[0])));
	// Lifts out blue, as the scan found it, and settles to grey once the scan is done.
	const blue =
		smooth((t - r.at) / 0.12) *
		(1 - smooth((t - Math.max(SW[1], r.at + 0.4) - 0.1) / 0.5));
	return { blue, k: r.k, op, s, x, y };
}

function draw(t: number) {
	if (t <= 0) return null;
	const convY = lerp(CONV_Y0, CONV_Y1, spring(t, DROP_AT, 1.3));
	const convOut = 1 - smooth((t - CONV_OUT) / 0.45);
	const sx = sweepX(t);
	// Bars the scan has crossed turn blue, hold while it finishes, then ease back to grey.
	const lit = (px: number) =>
		smooth((sx - px) / 12) * (1 - smooth((t - SW[1] - 0.1) / 0.5));
	const sweepOp =
		smooth((t - SW[0] + 0.2) / 0.25) * (1 - smooth((t - SW[1]) / 0.3));
	const ideas = placed.map((_, i) => idea(t, i));
	const dimLinks = 1 - 0.75 * smooth((t - FADE[0]) / (FADE[1] - FADE[0]));
	const sel = ideas[SEL]!;

	// Cursor comes in from the lower right and rests on the chosen idea.
	const ck = spring(t, CURSOR_AT, 1.3);
	const cx = lerp(372, sel.x + 6, ck);
	const cy = lerp(190, sel.y + 4, ck);
	const cOp = smooth((t - CURSOR_AT) / 0.3);
	const press = t > PRESS - 0.08 && t < PRESS + 0.14;

	// The blue outline closes in on the chosen idea.
	const ok = spring(t, PRESS, 2);
	const oS = lerp(1.35, 1, ok);

	const card = grow(t, CARD_AT, CARD.x + 10, CARD.y + 30, 0.86, 1.6);
	const p = placed[SEL]!;
	const groups = [CARD.y + 54, CARD.y + 104];
	const type = (t0: number, d = 0.4) => smooth((t - t0) / d);

	return (
		<g>
			{/* Conversations: in one by one, then low; the scan turns their bars blue as it crosses. */}
			{convOut > 0.001 && (
				<g opacity={convOut}>
					{convX.map((x, c) => {
						const gr = grow(t, CONV_IN[c]!, x + CW / 2, CONV_Y0 + CH / 2);
						return (
							<g key={x} opacity={gr.op} transform={gr.transform}>
								<Conversation
									x={x}
									y={convY}
									k={smooth((t - CONV_IN[c]! - 0.15) / 0.7)}
									lit={lit}
								/>
							</g>
						);
					})}
					{/* Each idea's thread back to the conversation it came from. */}
					{raised.map((r) => {
						const i = ideas[r.to]!;
						const ax = clamp(r.x, convX[r.c]! + 14, convX[r.c]! + CW - 14);
						return (
							<Curve
								key={r.to}
								x1={ax}
								y1={convY - 2}
								x2={i.x}
								y2={i.y + (TH / 2) * i.s + 2}
								bend={0.12}
								k={smooth((t - r.at) / 0.4)}
							/>
						);
					})}
				</g>
			)}

			{/* Links between neighbours, drawn once the kinds have gathered. */}
			{links.map(([a, b], li) => (
				<Curve
					key={`${a}-${b}`}
					x1={ideas[a]!.x}
					y1={ideas[a]!.y}
					x2={ideas[b]!.x}
					y2={ideas[b]!.y}
					k={smooth((t - LINK_AT[li]!) / LINK_D)}
					op={dimLinks}
				/>
			))}

			{ideas.map((d, i) =>
				d.op <= 0.001 ? null : (
					<g
						key={`${placed[i]!.x}-${placed[i]!.y}`}
						transform={`translate(${d.x} ${d.y}) scale(${d.s}) translate(${-d.x} ${-d.y})`}
					>
						<Idea x={d.x} y={d.y} k={d.k} op={d.op} blue={d.blue} />
					</g>
				),
			)}

			{/* The one blue thing: first the sweep, later the outline on the chosen idea. */}
			{sweepOp > 0.001 && (
				<line
					x1={sx}
					x2={sx}
					y1={convY - 8}
					y2={convY + CH + 8}
					stroke={C.action}
					strokeWidth={2}
					strokeLinecap="round"
					opacity={sweepOp}
				/>
			)}
			{ok > 0.001 && (
				<rect
					x={sel.x - (TW / 2) * oS}
					y={sel.y - (TH / 2) * oS}
					width={TW * oS}
					height={TH * oS}
					rx={6}
					fill="none"
					stroke={C.action}
					strokeWidth={2}
					opacity={smooth((t - PRESS) / 0.25)}
				/>
			)}

			{/* The opened idea: its bar pattern on top, then quotes grouped by conversation. */}
			{t > CARD_AT && (
				<g opacity={card.op} transform={card.transform}>
					<rect
						x={CARD.x}
						y={CARD.y}
						width={CARD.w}
						height={CARD.h}
						rx={6}
						fill={C.surface}
						stroke={C.quiet}
						strokeWidth={1}
					/>
					{patterns[p.k]!.map((row, r) =>
						row.map(([dx, w]) => (
							<Pill
								key={`${r}-${dx}`}
								x={CARD.x + 14 + dx * 2.4}
								y={CARD.y + 14 + r * 9}
								w={w * 2.4}
								k={type(CARD_AT + 0.15 + r * 0.15)}
							/>
						)),
					)}
					{groups.map((gy, gi) => {
						const t0 = CARD_AT + 0.5 + gi * 0.5;
						const head = grow(t, t0, CARD.x + 20, gy + 6, 0.7);
						return (
							<g key={gy}>
								<g opacity={head.op} transform={head.transform}>
									<Person cx={CARD.x + 20} cy={gy} s={0.85} />
								</g>
								<Pill
									x={CARD.x + 36}
									y={gy - 4}
									w={gi ? 60 : 72}
									k={type(t0 + 0.1)}
								/>
								<Pill
									x={CARD.x + 36}
									y={gy + 5}
									w={gi ? 72 : 52}
									k={type(t0 + 0.25)}
								/>
								<Pill
									x={CARD.x + 36}
									y={gy + 14}
									w={gi ? 38 : 64}
									k={type(t0 + 0.4)}
								/>
							</g>
						);
					})}
				</g>
			)}

			<Cursor x={cx} y={cy} opacity={cOp} press={press} />
		</g>
	);
}

export const map: Loop = {
	draw,
	lines: () => [
		translate`Your conversations hold many ideas.`,
		translate`See the ideas people raised.`,
		translate`Related ideas sit side by side.`,
		translate`Open one to read the quotes.`,
	],
	out: OUT,
	scenes: [0, 4, 8, 12],
	seconds: 16,
};
export default map;
