import { t as translate } from "@lingui/core/macro";
// Every value is a function of t, so any frame renders on its own and the loop is exact.
import {
	Bars,
	C,
	clamp,
	type Loop,
	lerp,
	smooth,
	spring,
	type Word,
} from "./kit";

// Three tables of three people along the bottom; the room's big screen above.
const TABLES = [72, 180, 288];
const HEAD_Y = 138;
const SCREEN = { h: 68, w: 316, x: 22, y: 6 };

// A phrase card: one short row of grey bars, shorter than what the table said.
const CARD_W = 50;
const CARD_H = 16;
// Where each table's phrase settles on the screen (centre), and its tilt.
const ON_SCREEN = [
	{ cx: 92, cy: 26, scale: 1.4, tilt: -3 },
	{ cx: 196, cy: 52, scale: 1.4, tilt: 2.5 },
	{ cx: 278, cy: 24, scale: 1.4, tilt: -2 },
];
// Each phrase's words as bar widths: three short words, filling the card.
const WORDS = [
	[11, 8, 13],
	[9, 13, 10],
	[13, 10, 9],
];
// Where a table's phrase is caught, just above its talk.
const CAUGHT_Y = 90;

// The timeline: each table is caught in turn, one blue moment at a time.
const SCREEN_IN = 0.1;
const PEOPLE_IN = (table: number, seat: number) =>
	0.45 + table * 0.22 + seat * 0.07;
const VOICE_IN = (table: number) => 1.4 + table * 0.25;
const SCAN_AT = [3.6, 6.8, 10.0]; // dembrane's scan passes over each table's talk
const SCAN_LEN = 1.5;
const RELEASE = 1.8; // bars ease back to graphite, after the scan
const LIFT = 1.7; // the caught phrase rises onto the screen
const LET_GO = 2.7; // blue lets go as it lands
const TIE_AFTER = 2.7; // its link draws down to its table
const OUT = 15.3; // Frame fades everything out by 15.9

function Person({ x, y, k }: { x: number; y: number; k: number }) {
	if (k <= 0) return null;
	const foot = y + 18;
	return (
		<g
			transform={`translate(${x} ${foot}) scale(${k}) translate(${-x} ${-foot})`}
			opacity={clamp(k * 1.5)}
			fill="none"
			stroke={C.text}
			strokeWidth={1.4}
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<circle cx={x} cy={y} r={5} />
			<path
				d={`M${x - 8} ${y + 18} Q${x - 8} ${y + 8} ${x} ${y + 8} Q${x + 8} ${y + 8} ${x + 8} ${y + 18}`}
			/>
		</g>
	);
}

/** How loud a table is: grows in and keeps talking. */
function voiceAmp(t: number, table: number) {
	return clamp(spring(t, VOICE_IN(table), 1.6), 0, 1.06);
}

const BAR_X = (i: number) => i * 5.4 - 17;
const SCAN_FROM = -24;
const SCAN_TO = 26;

/** The scan's x for a table (relative to its centre) and how visible the line is. */
function scanState(t: number, table: number) {
	const t0 = SCAN_AT[table]!;
	const u = (t - t0) / SCAN_LEN;
	return {
		line: smooth(u / 0.1) * (1 - smooth((u - 0.9) / 0.1)),
		x: lerp(SCAN_FROM, SCAN_TO, smooth(u)),
	};
}

/** A voice: a short row of wave bars over the table. A blue scan passes over it and lights each bar. */
function Voice({ cx, table, t }: { cx: number; table: number; t: number }) {
	const amp = voiceAmp(t, table);
	if (amp <= 0.01) return null;
	const hs = [5, 10, 14, 8, 12, 6, 11];
	const scan = scanState(t, table);
	const release = 1 - smooth((t - SCAN_AT[table]! - RELEASE) / 0.5);
	return (
		<g>
			<g opacity={clamp(amp * 1.4)}>
				{hs.map((_, i) => {
					const b = hs[(i + table * 2) % hs.length]!;
					const breathe = 0.7 + 0.3 * Math.sin(t * 2.6 + i * 1.3 + table * 2.1);
					const h = Math.max(2.4, b * breathe * amp);
					const lit = smooth((scan.x - BAR_X(i)) / 12) * release;
					return (
						<g key={BAR_X(i)}>
							<rect
								x={cx + BAR_X(i)}
								y={122 - h / 2}
								width={2.4}
								height={h}
								rx={1.2}
								fill={C.text}
								opacity={0.75}
							/>
							{lit > 0.01 && (
								<rect
									x={cx + BAR_X(i)}
									y={122 - h / 2}
									width={2.4}
									height={h}
									rx={1.2}
									fill={C.action}
									opacity={lit}
								/>
							)}
						</g>
					);
				})}
			</g>
			{scan.line > 0.01 && (
				<line
					x1={cx + scan.x}
					x2={cx + scan.x}
					y1={111}
					y2={133}
					stroke={C.action}
					strokeWidth={2}
					strokeLinecap="round"
					opacity={scan.line}
				/>
			)}
		</g>
	);
}

function phraseWords(i: number, x0: number, y: number): Word[] {
	let x = x0;
	return WORDS[i]!.map((w) => {
		const out = { w, x, y };
		x += w + 3;
		return out;
	});
}

type Place = { cx: number; cy: number; tilt: number; scale: number };

/** One phrase: a hairline card, radius 6, holding a short row of grey bars. It grows in by k; blue is 0..1. */
function Phrase({
	i,
	at,
	k,
	typed,
	blue,
}: {
	i: number;
	at: Place;
	k: number;
	typed: number;
	blue: number;
}) {
	if (k <= 0) return null;
	const { cx, cy, tilt } = at;
	const scale = at.scale * lerp(0.55, 1, k);
	const x = cx - CARD_W / 2;
	const y = cy - CARD_H / 2;
	return (
		<g
			transform={`translate(${cx} ${cy}) rotate(${tilt}) scale(${scale}) translate(${-cx} ${-cy})`}
			opacity={clamp(k * 1.6)}
		>
			<rect
				x={x}
				y={y}
				width={CARD_W}
				height={CARD_H}
				rx={6}
				fill={C.surface}
				stroke={C.quiet}
				strokeWidth={1 / scale}
			/>
			{blue > 0.01 && (
				<rect
					x={x}
					y={y}
					width={CARD_W}
					height={CARD_H}
					rx={6}
					fill="none"
					stroke={C.action}
					strokeWidth={1.4 / scale}
					opacity={blue}
				/>
			)}
			<Bars
				words={phraseWords(i, x + 7, cy - 2)}
				k={typed}
				fill={C.muted}
				opacity={0.8}
			/>
		</g>
	);
}

/** A gentle curved hairline from a table up to its phrase, drawn along its curve by k. */
function Link({
	table,
	at,
	k,
	opacity,
}: {
	table: number;
	at: Place;
	k: number;
	opacity: number;
}) {
	if (k <= 0.005) return null;
	const x0 = TABLES[table]!;
	const y0 = 110;
	const y1 = at.cy + (CARD_H * at.scale) / 2 + 2;
	const d = `M${x0} ${y0} Q${x0} ${(y0 + y1) / 2 + 6} ${at.cx} ${y1}`;
	return (
		<path
			d={d}
			pathLength={1}
			strokeDasharray="1 1"
			strokeDashoffset={1 - clamp(k)}
			fill="none"
			stroke={C.quiet}
			strokeWidth={1.2}
			strokeLinecap="round"
			opacity={opacity}
		/>
	);
}

function Screen({ t }: { t: number }) {
	const k = spring(t, SCREEN_IN, 1.4);
	if (k <= 0) return null;
	const cx = SCREEN.x + SCREEN.w / 2;
	const cy = SCREEN.y + SCREEN.h / 2;
	const s = lerp(0.94, 1, k);
	return (
		<rect
			transform={`translate(${cx} ${cy}) scale(${s}) translate(${-cx} ${-cy})`}
			x={SCREEN.x}
			y={SCREEN.y}
			width={SCREEN.w}
			height={SCREEN.h}
			rx={6}
			fill="none"
			stroke={C.quiet}
			strokeWidth={1.5}
			opacity={clamp(k)}
		/>
	);
}

/** Where a table's phrase is: above its table, then moving up onto the screen with a slight arc. */
function placeOf(t: number, table: number): Place {
	const k = spring(t, SCAN_AT[table]! + LIFT, 1.05, 0.86);
	const to = ON_SCREEN[table]!;
	const arc = Math.sin(clamp(k) * Math.PI) * -6;
	return {
		cx: lerp(TABLES[table]!, to.cx, k) + arc * 0.5,
		cy: lerp(CAUGHT_Y, to.cy, k) + arc,
		scale: lerp(1, to.scale, k),
		tilt: lerp(0, to.tilt, k),
	};
}

function draw(t: number) {
	return (
		<g>
			<Screen t={t} />
			{TABLES.map((cx, table) => (
				<g key={cx}>
					{[-20, 0, 20].map((d, seat) => (
						<Person
							key={d}
							x={cx + d}
							y={HEAD_Y}
							k={spring(t, PEOPLE_IN(table, seat), 2)}
						/>
					))}
					<Voice cx={cx} table={table} t={t} />
				</g>
			))}
			{TABLES.map((cx, table) => {
				const s = SCAN_AT[table]!;
				const place = placeOf(t, table);
				return (
					<g key={cx}>
						<Link
							table={table}
							at={ON_SCREEN[table]!}
							k={smooth((t - s - TIE_AFTER) / 0.7)}
							opacity={0.8}
						/>
						{/* The key idea: caught in blue as the scan passes, blue as it lifts, normal once on the screen. */}
						<Phrase
							i={table}
							at={place}
							k={spring(t, s + 0.9, 1.8)}
							typed={smooth((t - s - 1.1) / 0.5)}
							blue={
								smooth((t - s - 1.0) / 0.2) *
								(1 - smooth((t - s - LET_GO) / 0.4))
							}
						/>
					</g>
				);
			})}
		</g>
	);
}

export const popcorn: Loop = {
	draw,
	lines: () => [
		translate`Every table talks at once.`,
		translate`Each table's key ideas, caught live.`,
		translate`They pop onto the big screen.`,
		translate`The room sees every table's thinking.`,
	],
	out: OUT,
	scenes: [0.2, 3.6, 7, 11],
	seconds: 16,
};
