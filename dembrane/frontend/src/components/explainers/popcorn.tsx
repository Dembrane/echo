import { t as translate } from "@lingui/core/macro";
// Every value is a function of t, so any frame renders on its own and the loop is exact.
import { about, ScanLine, Table } from "./cast";
import { C, clamp, type Loop, lerp, smooth, spring } from "./kit";

// Three tables of three people along the bottom; the room's big screen above.
const TABLES = [72, 180, 288];
const TABLE_Y = 148; // shoulder line of the cast Table
const TABLE_SCALE = 1.5; // the cast Table, drawn larger so its phone is readable here
const SCREEN = { h: 68, w: 316, x: 22, y: 6 };

// A phrase on the screen: the same idea pill Map uses (a hairline card, rows of grey bars).
const CARD_W = 34;
const CARD_H = 22;
// Where each table's phrase settles on the screen (centre), and its tilt.
const ON_SCREEN = [
	{ cx: 92, cy: 26, scale: 1.4, tilt: -3 },
	{ cx: 196, cy: 52, scale: 1.4, tilt: 2.5 },
	{ cx: 278, cy: 24, scale: 1.4, tilt: -2 },
];
// Each table's idea as bar rows [x offset, width], the way Map's ideas are patterned.
const PATTERNS: [number, number][][][] = [
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
// Where a table's phrase is caught, just above its talk.
const CAUGHT_Y = 90;

// The timeline: each table is caught in turn, one blue moment at a time.
const SCREEN_IN = 0.1;
const PEOPLE_IN = (table: number) => 0.45 + table * 0.22;
const VOICE_IN = (table: number) => 1.4 + table * 0.25;
const SCAN_AT = [3.6, 6.8, 10.0]; // dembrane's scan passes over each table's phone
const SCAN_LEN = 1.5;
const RELEASE = 1.8; // bars ease back to grey, after the scan
const LIFT = 1.7; // the caught phrase rises onto the screen
const LET_GO = 2.7; // blue lets go as it lands
const TIE_AFTER = 2.7; // its link draws down to its table
const OUT = 15.3; // Frame fades everything out by 15.9

/** How loud a table is: grows in and keeps talking. */
function voiceAmp(t: number, table: number) {
	return clamp(spring(t, VOICE_IN(table), 1.6), 0, 1.06);
}

// The cast Table's phone waveform, in the Table's own coordinates (its x, y).
const WAVE = [3, 6, 4, 5].map((h, i) => ({ h, i }));
const WAVE_X = (px: number, i: number) => px + 2.6 + i * 2.5;

/** One table: the cast Table, with a blue scan over its phone's waveform that lights each bar. */
function PopTable({ table, t }: { table: number; t: number }) {
	const k = spring(t, PEOPLE_IN(table), 2);
	if (k <= 0) return null;
	const cx = TABLES[table]!;
	const x = cx - 21;
	const px = x + 34;
	const amp = voiceAmp(t, table);
	const u = (t - SCAN_AT[table]!) / SCAN_LEN;
	const line = smooth(u / 0.1) * (1 - smooth((u - 0.9) / 0.1));
	const sx = lerp(px + 0.5, px + 14, smooth(u));
	const release = 1 - smooth((t - SCAN_AT[table]! - RELEASE) / 0.5);
	return (
		<g transform={about(cx, TABLE_Y + 10, TABLE_SCALE)}>
			<Table x={x} y={TABLE_Y} t={t} k={k} talk={amp} />
			{k > 0.9 &&
				WAVE.map(({ h, i }) => {
					const lit = smooth((sx - WAVE_X(px, i)) / 5) * release;
					if (lit <= 0.01) return null;
					const hh =
						h * (0.45 + 0.55 * amp * (0.7 + 0.3 * Math.sin(t * 4 + i)));
					return (
						<rect
							key={`w${i}`}
							x={WAVE_X(px, i)}
							y={TABLE_Y - 3 - hh / 2}
							width={1.6}
							height={hh}
							rx={0.8}
							fill={C.action}
							opacity={lit}
						/>
					);
				})}
			<ScanLine x={sx} y1={TABLE_Y - 11} y2={TABLE_Y + 5} opacity={line} />
		</g>
	);
}

type Place = { cx: number; cy: number; tilt: number; scale: number };

/** One phrase: Map's idea pill, a hairline card, radius 6, with rows of grey bars that turn blue while caught. */
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
	return (
		<g
			transform={`translate(${cx} ${cy}) rotate(${tilt}) scale(${scale}) translate(${-cx} ${-cy})`}
			opacity={clamp(k * 1.6)}
		>
			<rect
				x={cx - CARD_W / 2}
				y={cy - CARD_H / 2}
				width={CARD_W}
				height={CARD_H}
				rx={6}
				fill={C.surface}
				stroke={C.quiet}
				strokeWidth={1 / scale}
			/>
			{PATTERNS[i]!.map((row, r) =>
				row.map(([dx, w]) => (
					<IdeaBar
						key={`${r}-${dx}`}
						x={cx - 12 + dx}
						y={cy - 6 + r * 8}
						w={w * clamp(typed)}
						blue={blue}
					/>
				)),
			)}
		</g>
	);
}

/** A grey bar of an idea pill (4 high, round ends); blue is 0..1. */
function IdeaBar({
	x,
	y,
	w,
	blue,
}: {
	x: number;
	y: number;
	w: number;
	blue: number;
}) {
	if (w < 0.5) return null;
	const fade = clamp(w / 6);
	const width = Math.max(w, 4);
	return (
		<g>
			<rect
				x={x}
				y={y}
				width={width}
				height={4}
				rx={2}
				fill={C.muted}
				opacity={0.7 * fade * (1 - blue)}
			/>
			{blue > 0.001 && (
				<rect
					x={x}
					y={y}
					width={width}
					height={4}
					rx={2}
					fill={C.action}
					opacity={fade * blue}
				/>
			)}
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
	const y0 = 100;
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

function draw(t: number) {
	return (
		<g>
			<Screen t={t} />
			{TABLES.map((cx, table) => (
				<PopTable key={cx} table={table} t={t} />
			))}
			{TABLES.map((cx, table) => {
				const s = SCAN_AT[table]!;
				const to = ON_SCREEN[table]!;
				// The phrase never crosses the screen's edge: it fades out below it and the same phrase fades in on it.
				const u = smooth((t - s - LIFT) / 0.6);
				const k = spring(t, s + 0.9, 1.8);
				const typed = smooth((t - s - 1.1) / 0.5);
				const blue =
					smooth((t - s - 1.0) / 0.2) * (1 - smooth((t - s - LET_GO) / 0.4));
				const below: Place = {
					cx: TABLES[table]!,
					cy: CAUGHT_Y,
					scale: 1,
					tilt: 0,
				};
				const onScreen: Place = { ...to, cy: to.cy + lerp(3, 0, u) };
				return (
					<g key={cx}>
						<Link
							table={table}
							at={to}
							k={smooth((t - s - TIE_AFTER) / 0.7)}
							opacity={0.8}
						/>
						{/* The key idea: caught in blue as the scan passes, blue as it moves up, normal once on the screen. */}
						<g opacity={1 - u}>
							<Phrase i={table} at={below} k={k} typed={typed} blue={blue} />
						</g>
						<g opacity={u}>
							<Phrase i={table} at={onScreen} k={k} typed={typed} blue={blue} />
						</g>
					</g>
				);
			})}
		</g>
	);
}

export const popcorn: Loop = {
	draw,
	lines: () => [
		translate`All tables talk at once.`,
		translate`dembrane catches each table's key ideas.`,
		translate`They appear on the big screen.`,
		translate`Everyone sees what each table thinks.`,
	],
	out: OUT,
	scenes: [0.2, 3.6, 7, 11],
	seconds: 16,
};
