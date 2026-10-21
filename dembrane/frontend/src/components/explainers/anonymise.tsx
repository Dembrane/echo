import { t as translate } from "@lingui/core/macro";
// Anonymisation loop: every value is a function of t. Throwaway, never committed.
import { about, Person, span, Voice } from "./cast";
import { C, clamp, type Loop, lerp, rng, smooth, spring } from "./kit";

const GREY = C.muted;

/** Grow in about (cx, cy): a spring for the size, a short fade so nothing pops. */
const grow = (t: number, t0: number, from = 0.6, freq = 1.8) => ({
	o: smooth((t - t0) / 0.3),
	s: lerp(from, 1, spring(t, t0, freq)),
});
// The close-up table, drawn like Verify's: three people, the phone that records them.
const PX = [40, 88, 136];
const PERSON_Y = 96;
const PH = { h: 84, w: 40, x: 190, y: 56 };
const PCX = PH.x + PH.w / 2;
const WAVE_Y = PH.y + 36;
const WAVE_H = [6, 12, 9, 16, 10, 14, 7];
const WAVE_X = WAVE_H.map((_, i) => PCX - 12 + i * 4);
const REC = { cx: PCX, cy: PH.y + 16 };
const TALK = [
	{ a: 0.9, b: 1.8 },
	{ a: 1.7, b: 2.6 },
];
const talkBlue = (t: number) =>
	Math.max(...TALK.map((v) => span(t, v.a + 0.1, v.b, 0.25, 0.3)));
/** The table moves aside, smaller, as the transcript card arrives. */
const MOVE_AT = 1.7;
const TABLE_S = 0.7;
const TABLE_TX = -12.9;
const TABLE_TY = 19.4;
/** The lock arrives in beat 3, after the placeholders have settled (about 7.4 s). */
const LOCK_AT = 9.0;
const LOCK = { h: 20, w: 24, x: PCX - 12, y: PH.y + 38 };
/** The phone's right edge and middle once the table has moved: where the link to the card starts. */
const PHONE_OUT = {
	x: (PH.x + PH.w) * TABLE_S + TABLE_TX,
	y: (PH.y + PH.h / 2) * TABLE_S + TABLE_TY,
};

/** The phone: dot (blue while they talk), a small waveform; the lock closes over it in beat 3. */
function Phone({ t }: { t: number }) {
	const k = spring(t, 0.55, 1.7, 0.82);
	if (k <= 0) return null;
	const talk = talkBlue(t);
	const op =
		lerp(1, 0.25, smooth((t - 9.1) / 1.2)) * (1 - smooth((t - 12.2) / 0.9));
	return (
		<g
			transform={about(PCX, PH.y + PH.h / 2, lerp(0.6, 1, k))}
			opacity={clamp(k * 1.4)}
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<rect
				x={PH.x}
				y={PH.y}
				width={PH.w}
				height={PH.h}
				rx={8}
				fill={C.surface}
				stroke={C.text}
				strokeWidth={1.5}
			/>
			<line
				x1={PCX - 6}
				x2={PCX + 6}
				y1={PH.y + 7}
				y2={PH.y + 7}
				stroke={C.text}
				strokeWidth={1.5}
			/>
			<circle cx={REC.cx} cy={REC.cy} r={2.6} fill={C.muted} opacity={0.7} />
			{talk > 0.01 && (
				<circle
					cx={REC.cx}
					cy={REC.cy}
					r={2.6}
					fill={C.action}
					opacity={talk}
				/>
			)}
			{op > 0 &&
				WAVE_H.map((h, i) => {
					const x = WAVE_X[i] ?? 0;
					const breathe = 0.55 + 0.45 * Math.sin(t * 4.2 + i * 1.3);
					const hh = h * (0.45 + 0.55 * talk * breathe);
					return (
						<rect
							key={`w${h}-${x}`}
							x={x - 1.3}
							y={WAVE_Y - hh / 2}
							width={2.6}
							height={hh}
							rx={1.3}
							fill={C.muted}
							opacity={0.75 * op}
						/>
					);
				})}
		</g>
	);
}

/** The table: people talk, the phone records, then it slides aside to make room for the card. */
function Table({ t }: { t: number }) {
	const m = spring(t, MOVE_AT, 1.8);
	const s = lerp(1, TABLE_S, m);
	return (
		<g transform={`translate(${TABLE_TX * m} ${TABLE_TY * m}) scale(${s})`}>
			{PX.map((x, i) => (
				<Person
					key={x}
					x={x}
					y={PERSON_Y}
					k={spring(t, 0.15 + i * 0.15, 1.7, 0.82)}
				/>
			))}
			{TALK.map((v, i) => (
				<Voice key={v.a} x={PX[i * 2] ?? 0} y={63} t={t} a={v.a} b={v.b} />
			))}
			<Phone t={t} />
			<Lock t={t} />
		</g>
	);
}

/**
 * A soft lock on the phone: rounded body, curved shackle. It grows in blue, the shackle drops
 * shut, then it turns grey once the recording is gone.
 */
function Lock({ t }: { t: number }) {
	const { x, y, w, h } = LOCK;
	const { s, o } = grow(t, LOCK_AT, 0.5, 1.6);
	if (o <= 0) return null;
	const lift = lerp(-6, 0, spring(t, LOCK_AT + 1.9, 2.2));
	const grey = smooth((t - 12.6) / 0.6);
	const body = (color: string, op: number) => (
		<g
			opacity={op}
			fill={C.surface}
			stroke={color}
			strokeWidth={2}
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path
				d={`M${x + 6} ${y + lift} L${x + 6} ${y - 6 + lift} A6 6 0 0 1 ${x + w - 6} ${y - 6 + lift} L${x + w - 6} ${y + lift}`}
				fill="none"
			/>
			<rect x={x} y={y} width={w} height={h} rx={6} />
			<circle
				cx={x + w / 2}
				cy={y + h / 2}
				r={2.5}
				fill={color}
				stroke="none"
			/>
		</g>
	);
	return (
		<g opacity={o} transform={about(x + w / 2, y + h / 2, s)}>
			{grey < 1 && body(C.action, 1 - grey)}
			{grey > 0 && body(GREY, grey)}
		</g>
	);
}

/** The transcript card. Personal details are grey words that become fixed-size placeholder pills. */
type Word = {
	id: string;
	dx: number;
	dy: number;
	real: number;
	w: number;
	detail: boolean;
};
const CW = 180;
const CH = 144;
const DETAILS: Record<number, number[]> = {
	0: [1],
	1: [1],
	2: [0, 4],
	4: [1],
	5: [3],
};
const PILL = 22;
const ROWS: Word[][] = [0, 1, 2, 3, 4, 5].map((r) => {
	const rand = rng(31 + r * 7);
	const out: Word[] = [];
	let dx = 14;
	for (let i = 0; ; i++) {
		const detail = DETAILS[r]?.includes(i) ?? false;
		const w = detail ? PILL : 10 + rand() * 16;
		const real = detail ? 14 + rand() * 8 : w;
		if (dx + w > CW - 14) break;
		out.push({ detail, dx, dy: 22 + r * 20, id: `${r}-${dx}`, real, w });
		dx += w + 5;
	}
	return out;
});

const CARD_X = 166;
const CARD_Y = 16;
const CARD_AT = 2.0;
const ROW_AT = (r: number) => 2.4 + r * 0.14;

/** The blue sweep crosses the card once, left to right. */
const SWEEP: [number, number] = [4.4, 6.6];
const SWEEP_FROM = CARD_X - 4;
const SWEEP_TO = CARD_X + CW + 4;
const sweepX = (t: number) =>
	lerp(SWEEP_FROM, SWEEP_TO, smooth((t - SWEEP[0]) / (SWEEP[1] - SWEEP[0])));
/** When the sweep passes x: the inverse of sweepX, by bisection (smooth is monotonic). */
const crossAt = (x: number) => {
	let lo = SWEEP[0];
	let hi = SWEEP[1];
	for (let i = 0; i < 30; i++) {
		const mid = (lo + hi) / 2;
		if (sweepX(mid) < x) lo = mid;
		else hi = mid;
	}
	return lo;
};

function Card({ t }: { t: number }) {
	const { s, o } = grow(t, CARD_AT, 0.92, 1.6);
	if (o <= 0) return null;
	return (
		<g opacity={o} transform={about(CARD_X + CW / 2, CARD_Y + CH / 2, s)}>
			<rect
				x={CARD_X}
				y={CARD_Y}
				width={CW}
				height={CH}
				rx={6}
				fill={C.surface}
				stroke={C.quiet}
				strokeWidth={1.2}
			/>
			{ROWS.map((row, r) => {
				// The row types in from the left: an edge moves across and words appear behind it.
				const first = row[0];
				const last = row[row.length - 1];
				if (!first || !last) return null;
				const start = CARD_X + first.dx;
				const end = CARD_X + last.dx + last.w;
				const edge = lerp(start, end, smooth((t - ROW_AT(r)) / 0.5));
				return row.map((w) => {
					const wx = CARD_X + w.dx;
					const shown = clamp(edge - wx, 0, w.w);
					if (shown <= 0) return null;
					const wy = CARD_Y + w.dy;
					if (!w.detail) {
						return (
							<rect
								key={w.id}
								x={wx}
								y={wy}
								width={shown}
								height={4}
								rx={2}
								fill={GREY}
								opacity={0.5}
							/>
						);
					}
					// A personal detail: a bold pill, blue as the line crosses it, then its placeholder.
					const c = crossAt(wx + w.w / 2);
					const fadeAt = Math.max(c + 0.6, SWEEP[1] + 0.2);
					const blue =
						smooth((t - c) / 0.15) * (1 - smooth((t - fadeAt) / 0.5));
					const m = smooth((t - c - 0.3) / 0.4);
					const h = lerp(10, 8, m);
					const geo = {
						height: h,
						rx: h / 2,
						width: Math.min(shown, lerp(w.real, w.w, m)),
						x: wx,
						y: wy + 2 - h / 2,
					};
					return (
						<g key={w.id}>
							<rect
								{...geo}
								fill={C.text}
								opacity={0.85 * (1 - m) * (1 - blue)}
							/>
							<rect {...geo} fill={GREY} opacity={0.7 * m * (1 - blue)} />
							<rect {...geo} fill={C.action} opacity={blue} />
						</g>
					);
				});
			})}
		</g>
	);
}

/** A gentle curved hairline from the phone into the card; it draws along its curve, fades when the recording is locked. */
function Link({ t }: { t: number }) {
	const k = smooth((t - 2.1) / 0.5);
	const op = 1 - smooth((t - 8.2) / 0.4);
	if (k <= 0 || op <= 0) return null;
	const { x, y } = PHONE_OUT;
	return (
		<path
			d={`M${x + 3} ${y} Q${CARD_X - 8} ${y} ${CARD_X} ${CARD_Y + CH / 2 + 10}`}
			pathLength={1}
			strokeDasharray="1 1"
			strokeDashoffset={1 - k}
			opacity={op}
			fill="none"
			stroke={C.quiet}
			strokeWidth={1.2}
			strokeLinecap="round"
		/>
	);
}

/** The sweep line: grows in at the card's left, crosses it, shrinks away at the right. */
function Sweep({ t }: { t: number }) {
	const grow = spring(t, 4.2, 2.0) * (1 - smooth((t - 6.9) / 0.4));
	if (grow <= 0.01) return null;
	const x = sweepX(t);
	const cy = CARD_Y + CH / 2;
	const half = ((CH + 12) / 2) * grow;
	return (
		<line
			x1={x}
			x2={x}
			y1={cy - half}
			y2={cy + half}
			stroke={C.action}
			strokeWidth={2.5}
			strokeLinecap="round"
		/>
	);
}

export const anonymise: Loop = {
	draw: (t) => (
		<g>
			<Table t={t} />
			<Link t={t} />
			<Card t={t} />
			<Sweep t={t} />
		</g>
	),
	lines: () => [
		translate`Everyone talks as they normally would.`,
		translate`Names and personal details are replaced.`,
		translate`Audio playback and download are off.`,
		translate`The ideas stay. The names don't.`,
	],
	out: 15.36,
	scenes: [0, 4, 8, 12],
	seconds: 16,
};
export default anonymise;
