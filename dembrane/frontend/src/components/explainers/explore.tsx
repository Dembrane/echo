import { t as translate } from "@lingui/core/macro";
// Explore, animated: every value is a function of t, so any frame renders on its own. Throwaway, never committed.
import { about, MapMini, Person, ReportMini, span, Table, Voice } from "./cast";
import { C, clamp, type Loop, lerp, smooth, spring, win } from "./kit";

const GREY = C.muted;

// Beat starts; each beat's change happens inside its four seconds.
const BEATS = [0, 4, 9.4, 12.4, 16, 19.8];
const OUT = 23.8;
// The first table zooms out to become one of many.
const ZOOM = 15.5;

/** Grow in from a point with a soft spring: 0 before t0, about 1 after. */
const grow = (t: number, t0: number, freq = 1.8) =>
	Math.max(0, spring(t, t0, freq));
// The group, always talking once it is in: the conversation never stops in this loop.
const PEOPLE = [
	{ at: 0.15, x: 28, y: 112 },
	{ at: 0.3, x: 66, y: 118 },
	{ at: 0.45, x: 104, y: 112 },
];
function Group({ t }: { t: number }) {
	return (
		<g>
			{PEOPLE.map((p) => (
				<Person key={p.x} x={p.x} y={p.y + 11} k={grow(t, p.at, 1.6)} />
			))}
			<Voice x={48} y={94} t={t} a={1.0} b={ZOOM} s={0.7} />
			<Voice x={124} y={94} t={t} a={1.3} b={ZOOM} s={0.6} />
		</g>
	);
}

// The phone: recording (graphite dot, so the frame keeps its one blue for dembrane) and, at its lower edge, the ECHO button.
const PH = { h: 84, w: 42, x: 130, y: 50 };
const PCX = PH.x + PH.w / 2;
const WAVE_Y = PH.y + 36;
const REC = { cx: PCX, cy: PH.y + 16 };
const WAVE_H = [6, 11, 8, 15, 9, 13, 7];
const ECHO = { cx: PCX, cy: PH.y + PH.h - 13, h: 10, w: 30 };
const EXPLORE = { cx: PCX, cy: PH.y + PH.h - 29, h: 9, w: 24 };

// The taps: ECHO first, then Explore, which appears above it.
const TAP_ECHO = 5.05;
const EXPLORE_IN = 5.45;
const TAP_EXPLORE = 6.5;
const TAP_BLUE_OFF = 6.95;
const EXPLORE_OUT = 7.75;

/** A pill button: graphite outline, filled blue while it is the one being pressed. */
function Pill({
	cx,
	cy,
	w,
	h,
	blue,
	s = 1,
}: {
	cx: number;
	cy: number;
	w: number;
	h: number;
	blue: number;
	s?: number;
}) {
	if (s <= 0.01) return null;
	return (
		<g transform={about(cx, cy, s)} opacity={clamp(s)}>
			<rect
				x={cx - w / 2}
				y={cy - h / 2}
				width={w}
				height={h}
				rx={h / 2}
				fill={C.surface}
				stroke={C.text}
				strokeWidth={1.3}
			/>
			{blue > 0.01 && (
				<rect
					x={cx - w / 2}
					y={cy - h / 2}
					width={w}
					height={h}
					rx={h / 2}
					fill={C.action}
					stroke={C.action}
					strokeWidth={1.3}
					opacity={blue}
				/>
			)}
		</g>
	);
}

/** A soft grey ring that spreads from a pressed pill and fades. */
function Ripple({
	cx,
	cy,
	w,
	h,
	t,
	t0,
}: {
	cx: number;
	cy: number;
	w: number;
	h: number;
	t: number;
	t0: number;
}) {
	const k = clamp((t - t0) / 0.6);
	if (k <= 0 || k >= 1) return null;
	const e = 1 - (1 - k) ** 2;
	const pad = 2 + e * 3;
	return (
		<rect
			x={cx - w / 2 - pad}
			y={cy - h / 2 - pad}
			width={w + pad * 2}
			height={h + pad * 2}
			rx={h / 2 + pad}
			fill="none"
			stroke={GREY}
			strokeWidth={1}
			opacity={(1 - k) * 0.55}
		/>
	);
}

function Phone({ t }: { t: number }) {
	const k = grow(t, 0.5, 1.6);
	if (k <= 0) return null;
	const rec = smooth((t - 0.9) / 0.4);
	const talk = win(t, 1.05, 3.6, 0.3);
	const echoBlue =
		smooth((t - TAP_ECHO) / 0.15) * (1 - smooth((t - 5.75) / 0.3));
	const exploreBlue =
		smooth((t - TAP_EXPLORE) / 0.15) * (1 - smooth((t - TAP_BLUE_OFF) / 0.3));
	const exploreS = clamp(
		grow(t, EXPLORE_IN, 2) - grow(t, EXPLORE_OUT, 2.2),
		0,
		1.2,
	);
	return (
		<g
			transform={about(PCX, PH.y + PH.h / 2, 0.7 + 0.3 * k)}
			opacity={clamp(k)}
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
			{/* Recording dot: blue while people talk, grey before the taps. */}
			<circle cx={REC.cx} cy={REC.cy} r={2.6} fill={GREY} opacity={0.7} />
			{talk > 0.01 && (
				<circle
					cx={REC.cx}
					cy={REC.cy}
					r={2.6}
					fill={C.action}
					opacity={talk}
				/>
			)}
			{/* The phone listens: grey bars that breathe with the voices. */}
			<g fill={GREY} opacity={0.85 * rec}>
				{WAVE_H.map((h, i) => {
					const breathe = 0.5 + 0.5 * (0.5 + 0.5 * Math.sin(t * 3.4 + i * 1.7));
					const hh = Math.max(4, h * breathe * rec);
					return (
						<rect
							key={`wave-${h}-${i * 4}`}
							x={PCX - 12 + i * 4}
							y={WAVE_Y - hh / 2}
							width={3}
							height={hh}
							rx={1.5}
						/>
					);
				})}
			</g>
			<Ripple {...ECHO} t={t} t0={TAP_ECHO} />
			<Ripple {...EXPLORE} t={t} t0={TAP_EXPLORE} />
			<Pill {...EXPLORE} blue={exploreBlue} s={exploreS} />
			{/* ECHO: the one button people actually tap. */}
			<Pill {...ECHO} blue={echoBlue} />
		</g>
	);
}

/** A fingertip: a soft graphite circle that moves in, presses ECHO, then Explore, and lifts away. */
function Fingertip({ t }: { t: number }) {
	const from = { x: 214, y: 168 };
	const a = { x: ECHO.cx + 9, y: ECHO.cy + 5 };
	const b = { x: EXPLORE.cx + 10, y: EXPLORE.cy + 7 };
	const away = { x: 222, y: 160 };
	const k1 = spring(t, 4.2, 1.1, 0.9);
	const k2 = spring(t, 5.9, 1.4, 0.9);
	const k3 = smooth((t - 6.85) / 0.7);
	const x =
		from.x + (a.x - from.x) * k1 + (b.x - a.x) * k2 + (away.x - b.x) * k3;
	const y =
		from.y + (a.y - from.y) * k1 + (b.y - a.y) * k2 + (away.y - b.y) * k3;
	const op = smooth((t - 4.2) / 0.35) * (1 - smooth((t - 7.0) / 0.5));
	if (op < 0.01) return null;
	const press = (t0: number) =>
		smooth((t - t0 + 0.12) / 0.12) * (1 - smooth((t - t0 - 0.05) / 0.2));
	const p = Math.max(press(TAP_ECHO), press(TAP_EXPLORE));
	return (
		<g
			transform={`translate(${x} ${y}) scale(${1 + 0.14 * p} ${1 - 0.14 * p})`}
			opacity={op * 0.55}
		>
			<circle cx={0} cy={0} r={5.5} fill={C.text} />
		</g>
	);
}

// What dembrane heard so far: one straight row of grey pills running out of the phone, typed in from the left.
const TRAIL_Y = 118;
const TRAIL = [
	{ w: 14, x: 182 },
	{ w: 9, x: 200 },
	{ w: 17, x: 213 },
	{ w: 11, x: 234 },
	{ w: 15, x: 249 },
	{ w: 10, x: 268 },
];
const SCAN = { from: 7.4, settle: 9.2, to: 9.2 };
function Trail({ t }: { t: number }) {
	const start = 182;
	const end = 274;
	const edge = lerp(start, end, smooth((t - 1.3) / 2.2));
	const op = lerp(0.6, 0.35, smooth((t - 12.15) / 0.6));
	const scanX = lerp(
		start - 6,
		end + 6,
		smooth((t - SCAN.from) / (SCAN.to - SCAN.from)),
	);
	const settle = 1 - smooth((t - SCAN.settle) / 0.5);
	return (
		<g>
			<g fill={GREY} opacity={op}>
				{TRAIL.map((b) => {
					const w = Math.min(b.w, edge - b.x);
					if (w < 1) return null;
					return (
						<rect
							key={b.x}
							x={b.x}
							y={TRAIL_Y - 2.5}
							width={Math.max(w, 5)}
							height={5}
							rx={2.5}
						/>
					);
				})}
			</g>
			{TRAIL.map((b) => {
				const lit = smooth((scanX - (b.x + b.w / 2)) / 12) * settle;
				if (lit < 0.01) return null;
				return (
					<rect
						key={b.x}
						x={b.x}
						y={TRAIL_Y - 2.5}
						width={b.w}
						height={5}
						rx={2.5}
						fill={C.action}
						opacity={lit * op * 1.4}
					/>
				);
			})}
			{t > SCAN.from && t < SCAN.to + 0.3 && (
				<line
					x1={scanX}
					x2={scanX}
					y1={TRAIL_Y - 11}
					y2={TRAIL_Y + 11}
					stroke={C.action}
					strokeWidth={2}
					strokeLinecap="round"
					opacity={
						smooth((t - SCAN.from) / 0.15) * (1 - smooth((t - SCAN.to) / 0.3))
					}
				/>
			)}
		</g>
	);
}

// The reply: a hairline card of grey pills that ends in an open dashed pill, a question still to answer.
const CARD = { h: 54, w: 114, x: 230, y: 16 };
const OPEN = { w: 62, x: CARD.x + 14, y: CARD.y + 38 };
const REPLY_ROWS = [
	{ w: 34, x: 14, y: 12 },
	{ w: 22, x: 52, y: 12 },
	{ w: 22, x: 78, y: 12 },
	{ w: 24, x: 14, y: 24 },
	{ w: 38, x: 42, y: 24 },
];
const CARD_IN = 10.0;
const FILL_AT = 14.35;
function Reply({ t }: { t: number }) {
	const k = grow(t, CARD_IN, 1.6);
	if (k <= 0) return null;
	const { x, y, w, h } = CARD;
	// Reply text types in row by row, left to right.
	const typed = (row: number) =>
		smooth((t - CARD_IN - 0.45 - row * 0.45) / 0.5);
	const open = smooth((t - CARD_IN - 1.5) / 0.4);
	const filled = clamp(spring(t, FILL_AT, 1.6), 0, 1.05);
	return (
		<g transform={about(x, y + h / 2, 0.75 + 0.25 * k)} opacity={clamp(k)}>
			<rect
				x={x}
				y={y}
				width={w}
				height={h}
				rx={6}
				fill={C.surface}
				stroke={C.quiet}
				strokeWidth={1.2}
			/>
			<g fill={GREY} opacity={0.7}>
				{REPLY_ROWS.map((r) => {
					const row = r.y === 12 ? 0 : 1;
					const rowStart = row === 0 ? 14 : 14;
					const rowEnd = row === 0 ? 100 : 80;
					const edge = x + lerp(rowStart, rowEnd, typed(row));
					const ww = Math.min(r.w, edge - (x + r.x));
					if (ww < 1) return null;
					return (
						<rect
							key={`${r.x}-${r.y}`}
							x={x + r.x}
							y={y + r.y}
							width={Math.max(ww, 5)}
							height={5}
							rx={2.5}
						/>
					);
				})}
			</g>
			<rect
				x={OPEN.x}
				y={OPEN.y - 0.5}
				width={OPEN.w}
				height={6}
				rx={3}
				fill="none"
				stroke={GREY}
				strokeWidth={1.3}
				strokeDasharray="3.5 3"
				strokeLinecap="round"
				opacity={open * (1 - smooth((t - FILL_AT - 0.1) / 0.4))}
			/>
			{filled > 0.01 && (
				<rect
					x={OPEN.x}
					y={OPEN.y}
					width={Math.max(5, OPEN.w * filled)}
					height={5}
					rx={2.5}
					fill={GREY}
					opacity={0.7}
				/>
			)}
		</g>
	);
}

/** dembrane's reply travels along a blue curve from the phone up to the card; later it rests as a hairline. */
const LINK = {
	cx: 204,
	cy: 30,
	x0: PH.x + PH.w + 3,
	x1: CARD.x - 4,
	y0: PH.y + 22,
	y1: CARD.y + 26,
};
const LINK_AT = 9.8;
function Link({ t }: { t: number }) {
	const draw = smooth((t - LINK_AT) / 0.85);
	if (draw <= 0) return null;
	const head = smooth((t - LINK_AT - 0.7) / 0.2);
	const calm = smooth((t - 11.2) / 0.6);
	const { x0, y0, cx, cy, x1, y1 } = LINK;
	const path = (color: string, width: number, op: number) => (
		<g
			fill="none"
			stroke={color}
			strokeWidth={width}
			strokeLinecap="round"
			strokeLinejoin="round"
			opacity={op}
		>
			<path
				d={`M${x0} ${y0} Q${cx} ${cy} ${x1} ${y1}`}
				pathLength={1}
				strokeDasharray="1 1"
				strokeDashoffset={1 - draw}
			/>
			<path
				d={`M${x1 - 6} ${y1 - 5} L${x1} ${y1} L${x1 - 6.5} ${y1 + 4}`}
				opacity={head}
			/>
		</g>
	);
	return (
		<g>
			{calm > 0.01 && path(C.quiet, 1.2, calm)}
			{calm < 0.99 && path(C.action, 1.6, 1 - calm)}
		</g>
	);
}

/** New talk bends off the old row and rises toward the reply's open slot: pills laid along a curve, one after another. */
function NewAngle({ t }: { t: number }) {
	const p0 = { x: 288, y: TRAIL_Y };
	const c = { x: 312, y: TRAIL_Y - 2 };
	const p1 = { x: 320, y: CARD.y + CARD.h + 6 };
	const at = (u: number) => ({
		a:
			(Math.atan2(
				2 * (1 - u) * (c.y - p0.y) + 2 * u * (p1.y - c.y),
				2 * (1 - u) * (c.x - p0.x) + 2 * u * (p1.x - c.x),
			) *
				180) /
			Math.PI,
		x: (1 - u) ** 2 * p0.x + 2 * (1 - u) * u * c.x + u * u * p1.x,
		y: (1 - u) ** 2 * p0.y + 2 * (1 - u) * u * c.y + u * u * p1.y,
	});
	const us = [0.08, 0.36, 0.64, 0.92];
	const end = grow(t, 14.35, 2);
	return (
		<g fill={GREY} opacity={0.85}>
			{end > 0.01 && (
				<rect
					x={p1.x - 8}
					y={p1.y + 4}
					width={16}
					height={7}
					rx={3.5}
					fill={C.surface}
					stroke={C.quiet}
					strokeWidth={1}
					opacity={clamp(end)}
				/>
			)}
			{us.map((u, i) => {
				const k = grow(t, 12.75 + i * 0.38, 2);
				if (k <= 0) return null;
				const q = at(u);
				return (
					<rect
						key={u}
						x={-6}
						y={-2.5}
						width={12}
						height={5}
						rx={2.5}
						opacity={clamp(k)}
						transform={`translate(${q.x} ${q.y}) rotate(${q.a}) scale(${Math.max(0.3, k)} 1)`}
					/>
				);
			})}
		</g>
	);
}

// Beat 5: four tables, each with its own trail that branches into two ideas as its Explore reply arrives.
// Every table owns a 36 px band; its two ideas sit one above and one below the table's line, so no branch
// crosses another pill and no pill touches another.
const TABLES = [
	{ at: 16.1, to: "map", y: 34 },
	{ at: 16.9, to: "map", y: 70 },
	{ at: 17.7, to: "report", y: 106 },
	{ at: 18.5, to: "report", y: 142 },
];
const IDEA_X = [164, 204];
const IDEA_DY = [-9, 9];
const TX = 12;
const BRANCH_FROM = 108;
const SMALL = [
	{ w: 8, x: 60 },
	{ w: 5, x: 71 },
	{ w: 9, x: 79 },
	{ w: 6, x: 91 },
];
// Beat 6, step one: the ideas come back to the table and settle beside it.
const BACK = 19.95;
const BACK_DUR = 0.9;
const BACK_STAGGER = 0.08;
const SETTLE_X = 86;
const SETTLE_DY = [-5, 5];
// Step two, after the session: copies of the insights go to Map and Report.
const MAP_AT = { x: 290, y: 14 };
const REPORT_AT = { x: 296, y: 84 };
const LAND_X = 276;
const LAND_Y = [24, 40, 98, 114];
const FLY = [21.25, 21.4, 21.9, 22.05];
const FLY_DUR = 0.7;
const AWAY = { dur: 0.5, from: 23.25 };
const IDEA_PILL = { h: 7, w: 18 };

function Idea({
	x,
	y,
	s = 1,
	op = 1,
	stroke = C.text,
}: {
	x: number;
	y: number;
	s?: number;
	op?: number;
	stroke?: string;
}) {
	return (
		<rect
			x={-9}
			y={-3.5}
			width={IDEA_PILL.w}
			height={IDEA_PILL.h}
			rx={3.5}
			fill={C.surface}
			stroke={stroke}
			strokeWidth={1}
			opacity={op}
			transform={`translate(${x} ${y}) scale(${s})`}
		/>
	);
}

function Explored({ t }: { t: number }) {
	if (t < ZOOM || t > OUT + 0.3) return null;
	const zoom = smooth((t - ZOOM) / 0.9);
	const gone = 1 - smooth((t - AWAY.from) / AWAY.dur);
	return (
		<g opacity={gone}>
			{TABLES.map((tb, ti) => {
				const blue =
					smooth((t - tb.at) / 0.15) * (1 - smooth((t - tb.at - 0.7) / 0.2));
				const k = ti === 0 ? zoom : grow(t, tb.at - 0.4, 1.6);
				const back = BACK + ti * BACK_STAGGER;
				const ret = smooth((t - back) / BACK_DUR);
				const trail =
					smooth((t - tb.at + 0.2) / 0.5) * (1 - smooth((t - back) / 0.3));
				return (
					<g key={tb.y}>
						<Table x={TX} y={tb.y} t={t} k={k} talk={1} dot={blue} lit={blue} />
						<g fill={GREY} opacity={0.6 * trail}>
							{SMALL.map((b) => (
								<rect
									key={b.x}
									x={b.x}
									y={tb.y - 1.75}
									width={Math.max(2, b.w * trail)}
									height={3.5}
									rx={1.75}
								/>
							))}
						</g>
						{IDEA_X.map((ex, bi) => {
							const ey = tb.y + IDEA_DY[bi];
							const s0 = tb.at + 0.15 + bi * 0.18;
							const draw = smooth((t - s0) / 0.6);
							if (draw <= 0) return null;
							const stroke = blue > 0.01 ? C.action : GREY;
							const pill = grow(t, s0 + 0.5, 2);
							// Coming back: the line fades and the pill glides straight home, staying in its half of the band.
							const sx = SETTLE_X;
							const sy = tb.y + SETTLE_DY[bi];
							const px = lerp(ex, sx, ret);
							const py = lerp(ey, sy, ret);
							const rest = ret <= 0.001;
							const lineOp = 1 - smooth(ret / 0.3);
							return (
								<g key={ex}>
									{lineOp > 0.01 && (
										<path
											d={`M${BRANCH_FROM} ${tb.y} Q${(BRANCH_FROM + ex - 9) / 2} ${tb.y} ${ex - 9} ${ey}`}
											fill="none"
											stroke={stroke}
											strokeWidth={1.2}
											strokeLinecap="round"
											pathLength={1}
											strokeDasharray="1 1"
											strokeDashoffset={1 - draw}
											opacity={lineOp}
										/>
									)}
									{pill > 0.01 && (
										<Idea
											x={rest ? ex : px}
											y={rest ? ey : py}
											s={rest ? Math.max(0.3, pill) : 1}
											op={clamp(pill)}
											stroke={ret > 0.3 ? C.text : stroke}
										/>
									)}
								</g>
							);
						})}
					</g>
				);
			})}
		</g>
	);
}

/** Beat 6, after the session: copies of each table's insights glide into Map and Report, each lighting blue once. */
function Gather({ t }: { t: number }) {
	if (t < 20.9 || t > OUT + 0.3) return null;
	const mapK = grow(t, 21.0, 1.6);
	const repK = grow(t, 21.65, 1.6);
	const away = 1 - smooth((t - AWAY.from) / AWAY.dur);
	const mapLit = span(t, 21.95, 22.4, 0.15, 0.3);
	const repLit = span(t, 22.6, 23.05, 0.15, 0.3);
	return (
		<g>
			<g opacity={away}>
				<MapMini {...MAP_AT} k={mapK} lit={mapLit} />
				<ReportMini {...REPORT_AT} k={repK} lit={repLit} />
			</g>
			{TABLES.flatMap((tb, ti) =>
				IDEA_DY.map((dy, bi) => {
					const u = smooth((t - FLY[ti]) / FLY_DUR);
					if (u <= 0 || u >= 1) return null;
					const x0 = SETTLE_X + 20;
					const y0 = tb.y + SETTLE_DY[bi];
					const x1 = LAND_X;
					const y1 = LAND_Y[ti] + (bi === 0 ? -4 : 4);
					const x = lerp(x0, x1, u);
					const y = lerp(y0, y1, u);
					return (
						<Idea
							key={`${tb.y}-${dy}`}
							x={x}
							y={y}
							s={lerp(0.3, 1, smooth(u / 0.25)) * lerp(1, 0.6, u)}
							op={smooth(u / 0.2) * (1 - smooth((u - 0.8) / 0.2))}
						/>
					);
				}),
			)}
		</g>
	);
}

export const explore: Loop = {
	draw: (t) => {
		const zk = smooth((t - ZOOM) / 0.9);
		const scene = 1 - smooth((zk - 0.55) / 0.45);
		return (
			<g transform="translate(0 9)">
				{t < ZOOM + 1.2 && (
					<g
						opacity={scene}
						transform={`translate(${1.4 * zk} ${-12 * zk}) scale(${lerp(1, 0.38, zk)})`}
					>
						<Group t={t} />
						<Trail t={t} />
						<Link t={t} />
						<Reply t={t} />
						<NewAngle t={t} />
						<Phone t={t} />
						<Fingertip t={t} />
					</g>
				)}
				<Explored t={t} />
				<Gather t={t} />
			</g>
		);
	},
	lines: () => [
		translate`Talk it through at your table.`,
		translate`Tap ECHO, then tap Explore.`,
		translate`Get a reply that goes deeper.`,
		translate`Take the conversation somewhere new.`,
		translate`Every table explores more ideas.`,
		translate`Leave with new insights to explore.`,
	],
	out: OUT,
	scenes: BEATS,
	seconds: 24.3,
};
