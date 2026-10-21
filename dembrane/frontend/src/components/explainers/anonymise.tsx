import { t as translate } from "@lingui/core/macro";
// Anonymisation loop: every value is a function of t. Throwaway, never committed.
import { C, clamp, type Loop, lerp, rng, smooth, spring } from "./kit";

const GREY = C.muted;

/** Grow in about (cx, cy): a spring for the size, a short fade so nothing pops. */
const grow = (t: number, t0: number, from = 0.6, freq = 1.8) => ({
	o: smooth((t - t0) / 0.3),
	s: lerp(from, 1, spring(t, t0, freq)),
});
const about = (cx: number, cy: number, s: number) =>
	`translate(${cx} ${cy}) scale(${s}) translate(${-cx} ${-cy})`;

/** A person: head over a short rounded shoulder arc, graphite. */
function Person({
	x,
	y,
	t,
	t0,
}: {
	x: number;
	y: number;
	t: number;
	t0: number;
}) {
	const { s, o } = grow(t, t0);
	if (o <= 0) return null;
	return (
		<g
			opacity={o}
			transform={about(x, y + 8, s)}
			fill="none"
			stroke={C.text}
			strokeWidth={1.5}
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<circle cx={x} cy={y} r={6} />
			<path
				d={`M${x - 11} ${y + 22} Q${x - 11} ${y + 11} ${x} ${y + 11} Q${x + 11} ${y + 11} ${x + 11} ${y + 22}`}
			/>
		</g>
	);
}

const PEOPLE = [30, 74, 118];
const PEOPLE_AT = [0.2, 0.4, 0.6];

/** The recording: one waveform of pill bars under the people. */
const WAVE = [
	8, 14, 10, 20, 12, 16, 8, 18, 12, 22, 10, 14, 18, 8, 16, 12, 20, 10,
];
const WAVE_X = 14;
const WAVE_Y = 118;
const WAVE_AT = 0.9;
/** The lock arrives in beat 3, after the placeholders have settled (about 7.4 s). */
const LOCK_AT = 9.0;
const LOCK = { h: 24, w: 28, x: 112, y: 106 };

/** Bars grow in left to right, then fold toward the lock and fade as it closes. */
function Wave({ t }: { t: number }) {
	const fold = 0.55 * smooth((t - 9.1) / 1.2) + 0.45 * smooth((t - 12.2) / 0.9);
	const op =
		lerp(1, 0.25, smooth((t - 9.1) / 1.2)) * (1 - smooth((t - 12.2) / 0.9));
	if (op <= 0 || t < WAVE_AT) return null;
	const target = LOCK.x + LOCK.w / 2;
	return (
		<g opacity={op * 0.7} fill={GREY}>
			{WAVE.map((h0, i) => {
				const id = `${i}-${h0}`;
				const at = WAVE_AT + i * 0.04;
				const k = spring(t, at, 2.2);
				if (k <= 0) return null;
				const x0 = WAVE_X + i * 7;
				const x = x0 + (target - x0) * fold;
				const h = Math.max(3, h0 * k * (1 - 0.6 * fold));
				return (
					<rect
						key={id}
						x={x}
						y={WAVE_Y - h / 2}
						width={3}
						height={h}
						rx={1.5}
						opacity={smooth((t - at) / 0.2)}
					/>
				);
			})}
		</g>
	);
}

/**
 * A soft lock: rounded body, curved shackle. It grows in blue, the shackle drops shut,
 * then it turns grey once the recording is gone.
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
				d={`M${x + 7} ${y + lift} L${x + 7} ${y - 6 + lift} A7 7 0 0 1 ${x + w - 7} ${y - 6 + lift} L${x + w - 7} ${y + lift}`}
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
const PH = 22;
const ROWS: Word[][] = [0, 1, 2, 3, 4, 5].map((r) => {
	const rand = rng(31 + r * 7);
	const out: Word[] = [];
	let dx = 14;
	for (let i = 0; ; i++) {
		const detail = DETAILS[r]?.includes(i) ?? false;
		const w = detail ? PH : 10 + rand() * 16;
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

/** A gentle curved hairline from the recording into the card; it draws along its curve, fades when the recording is locked. */
function Link({ t }: { t: number }) {
	const k = smooth((t - 1.5) / 0.6);
	const op = 1 - smooth((t - 8.2) / 0.4);
	if (k <= 0 || op <= 0) return null;
	return (
		<path
			d={`M${WAVE_X + WAVE.length * 7 + 4} ${WAVE_Y} Q${CARD_X - 6} ${WAVE_Y} ${CARD_X} ${CARD_Y + CH / 2 + 10}`}
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
			{PEOPLE.map((x, i) => (
				<Person key={x} x={x} y={36} t={t} t0={PEOPLE_AT[i] ?? 0} />
			))}
			<Link t={t} />
			<Wave t={t} />
			<Lock t={t} />
			<Card t={t} />
			<Sweep t={t} />
		</g>
	),
	lines: () => [
		translate`Talk freely, names and all.`,
		translate`Personal details become placeholders.`,
		translate`No playback, no download.`,
		translate`Keep what was said, not names.`,
	],
	out: 15.36,
	scenes: [0, 4, 8, 12],
	seconds: 16,
};
export default anonymise;
