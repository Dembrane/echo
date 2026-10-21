import { t as translate } from "@lingui/core/macro";
import {
	AskMini,
	about,
	MapMini,
	Outcome,
	Person,
	ReportMini,
	span,
	Table,
	Voice,
} from "./cast";
// Every value is a pure function of t, so any frame renders on its own and the loop is exact.
import {
	Bars,
	C,
	clamp,
	type Loop,
	lerp,
	lineWords,
	smooth,
	spring,
	type Word,
} from "./kit";

const PX = [40, 88, 136];
const PERSON_Y = 96;

// The phone: records the talk (a small waveform and a dot) and has the ECHO pill at its lower edge.
const PH = { h: 84, w: 40, x: 190, y: 56 };
const PCX = PH.x + PH.w / 2;
const ECHO = { cx: PCX, cy: PH.y + PH.h - 13, h: 10, w: 30 };
const SECOND = { cx: PCX, cy: PH.y + PH.h - 29, h: 9, w: 24 };
const WAVE_Y = PH.y + 36;
const WAVE_H = [6, 12, 9, 16, 10, 14, 7];
const WAVE_X = WAVE_H.map((_, i) => PCX - 12 + i * 4);
const REC = { cx: PCX, cy: PH.y + 16 };

// Beat timing. Blue is handed on, never shared: the dot is blue only while people talk, a tapped
// pill is blue for a moment, the scan lights the waveform, and the card outline waits for approval.
const TAP_ECHO1 = 4.5;
const SECOND_IN1 = 4.85;
const TAP_VERIFY = 5.6;
const SECOND_OUT1 = 6.5;
const SCAN1 = { a: 6.7, d: 1.5, h: 0.3 };
const CARD = 7.6;
const LINK = 7.5;
const ROWS1 = 8.0;
const TALK2 = { a: 11.2, b: 12.0 };
const TAP_ECHO2 = 12.05;
const SECOND_IN2 = 12.4;
const TAP_REVISE = 12.95;
const SECOND_OUT2 = 13.7;
const SCAN2 = { a: 13.15, d: 0.65, h: 0.05 };
const REWRITE = 14.15;
const TAP_APPROVE = 15.7;
const APPROVE = 15.8;
// Zoom out: the approved card turns into an Outcome and the close-up eases away.
const MORPH = 17.9;
const ZOOM = 17.9;
const TX = [20, 108, 196, 284];
const TABLE_Y = 40;
const TABLE_IN = [19.0, 19.5, 20.0, 20.5];
const OUT_IN = [0, 20.2, 20.7, 21.2];
const OUT_Y = 58;
const OUT_W = 40;
const outCx = (i: number) => TX[i]! + 21;

/** Blue while someone talks: the recording dot. */
const talkBlue = (t: number) =>
	Math.max(
		span(t, 1.05, 3.6, 0.25, 0.3),
		span(t, TALK2.a + 0.1, TALK2.b, 0.25, 0.3),
	);

/** 0 to 1 along the scan: the line crosses the waveform left to right. */
const scanX = (t: number, s: { a: number; d: number; h: number }) =>
	lerp(PCX - 16, PCX + 16, smooth((t - s.a) / s.d));
const scanLine = (t: number, s: { a: number; d: number; h: number }) =>
	smooth((t - s.a) / 0.15) * (1 - smooth((t - s.a - s.d + 0.1) / 0.2));
/** How blue the waveform is: lit as the line passes, held, then back to grey over 0.5 s. */
const litHold = (t: number, s: { a: number; d: number; h: number }) =>
	1 - smooth((t - s.a - s.d - s.h) / 0.5);

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
	x,
	y,
	t,
	tp,
}: {
	x: number;
	y: number;
	t: number;
	tp: number;
}) {
	const k = smooth((t - tp) / 0.7);
	if (k <= 0 || k >= 1) return null;
	return (
		<circle
			cx={x}
			cy={y}
			r={lerp(6, 20, k)}
			fill="none"
			stroke={C.text}
			strokeWidth={1}
			opacity={0.35 * (1 - k)}
		/>
	);
}

function Ring({
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
	const pad = 2 + (1 - (1 - k) ** 2) * 1.5;
	return (
		<rect
			x={cx - w / 2 - pad}
			y={cy - h / 2 - pad}
			width={w + pad * 2}
			height={h + pad * 2}
			rx={h / 2 + pad}
			fill="none"
			stroke={C.muted}
			strokeWidth={1}
			opacity={(1 - k) * 0.7}
		/>
	);
}

const nearby = (t: number, tps: number[]) =>
	Math.max(
		...tps.map(
			(tp) =>
				smooth((t - tp + 0.12) / 0.12) * (1 - smooth((t - tp - 0.05) / 0.2)),
		),
	);

/**
 * A fingertip: a soft graphite circle that comes up from below-right, presses a, then b (if given),
 * and lifts away. It rests at the pill's lower-right edge so the pill stays readable.
 */
function Fingertip({
	a,
	b,
	ta,
	tb,
	t,
}: {
	a: { x: number; y: number };
	b?: { x: number; y: number };
	ta: number;
	tb?: number;
	t: number;
}) {
	const to = b ?? a;
	const tEnd = tb ?? ta;
	const t0 = ta - 0.8;
	const from = { x: a.x + 24, y: 180 };
	const away = { x: to.x + 22, y: to.y + 40 };
	const k1 = spring(t, t0, 1.2, 0.9);
	const k2 = tb === undefined ? 0 : spring(t, ta + 0.3, 1.5, 0.9);
	const k3 = smooth((t - tEnd - 0.3) / 0.7);
	const x =
		from.x + (a.x - from.x) * k1 + (to.x - a.x) * k2 + (away.x - to.x) * k3;
	const y =
		from.y + (a.y - from.y) * k1 + (to.y - a.y) * k2 + (away.y - to.y) * k3;
	const op = smooth((t - t0) / 0.35) * (1 - smooth((t - tEnd - 0.5) / 0.5));
	if (op < 0.01) return null;
	const p = nearby(t, tb === undefined ? [ta] : [ta, tb]);
	return (
		<g
			transform={`translate(${x} ${y}) scale(${1 + 0.14 * p} ${1 - 0.16 * p})`}
			opacity={op * 0.9}
		>
			<circle r={6.5} fill={C.text} />
		</g>
	);
}

/** The phone and its recording: dot, waveform of grey pills that breathes with the voices, the scan, the pills. */
function PhoneScene({ t }: { t: number }) {
	const k = spring(t, 0.55, 1.7, 0.82);
	if (k <= 0) return null;
	const talk = talkBlue(t);
	const echo1 = span(t, TAP_ECHO1, TAP_ECHO1 + 0.3, 0.1, 0.3);
	const verify = span(t, TAP_VERIFY, TAP_VERIFY + 0.3, 0.1, 0.3);
	const echo2 = span(t, TAP_ECHO2, TAP_ECHO2 + 0.3, 0.1, 0.3);
	const revise = span(t, TAP_REVISE, TAP_REVISE + 0.3, 0.1, 0.3);
	const in1 = clamp(
		spring(t, SECOND_IN1, 2) - spring(t, SECOND_OUT1, 2.2),
		0,
		1.2,
	);
	const in2 = clamp(
		spring(t, SECOND_IN2, 2) - spring(t, SECOND_OUT2, 2.2),
		0,
		1.2,
	);
	const lit1 = litHold(t, SCAN1);
	const lit2 = litHold(t, SCAN2);
	const lines = [
		{ op: scanLine(t, SCAN1), s: SCAN1 },
		{ op: scanLine(t, SCAN2), s: SCAN2 },
	];
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
			{WAVE_H.map((h, i) => {
				const x = WAVE_X[i]!;
				const breathe = 0.55 + 0.45 * Math.sin(t * 4.2 + i * 1.3);
				const hh = h * (0.28 + 0.72 * talk * breathe);
				const lit = Math.max(
					smooth((scanX(t, SCAN1) - x) / 12) * lit1,
					smooth((scanX(t, SCAN2) - x) / 12) * lit2,
				);
				return (
					<g key={x}>
						<rect
							x={x - 1.3}
							y={WAVE_Y - hh / 2}
							width={2.6}
							height={hh}
							rx={1.3}
							fill={C.muted}
							opacity={0.75}
						/>
						{lit > 0.01 && (
							<rect
								x={x - 1.3}
								y={WAVE_Y - hh / 2}
								width={2.6}
								height={hh}
								rx={1.3}
								fill={C.action}
								opacity={lit}
							/>
						)}
					</g>
				);
			})}
			{lines.map(({ s, op }) =>
				op > 0.01 ? (
					<line
						key={s.a}
						x1={scanX(t, s)}
						x2={scanX(t, s)}
						y1={WAVE_Y - 12}
						y2={WAVE_Y + 12}
						stroke={C.action}
						strokeWidth={2}
						opacity={op}
					/>
				) : null,
			)}
			<Ring {...ECHO} t={t} t0={TAP_ECHO1} />
			<Ring {...SECOND} t={t} t0={TAP_VERIFY} />
			<Ring {...ECHO} t={t} t0={TAP_ECHO2} />
			<Ring {...SECOND} t={t} t0={TAP_REVISE} />
			<Pill
				{...SECOND}
				blue={Math.max(verify, revise)}
				s={Math.max(in1, in2)}
			/>
			<Pill {...ECHO} blue={Math.max(echo1, echo2)} />
		</g>
	);
}

// The summary card: three short rows. One row is misread (dashed) until people revise it.
const CX = 256;
const CY = 52;
const CW = 92;
const CH = 72;
const ROW_Y = [CY + 18, CY + 34, CY + 50];
const ROW_END = [CX + CW - 12, CX + CW - 18, CX + CW - 40];
const rows: Word[][] = ROW_Y.map((y, i) =>
	lineWords(41 + i, CX + 12, y, ROW_END[i]!, 10, 22),
);
const DOUBT = 1;
// The misreading: the same row in different, shorter words, so it visibly does not match.
const wrong = Array.from({ length: 7 }, (_, i) => ({
	w: 7,
	x: CX + 12 + i * 10,
	y: ROW_Y[DOUBT]! - 1.5,
}));
const rowSpan = (r: Word[]) => ({
	w: r[r.length - 1]!.x + r[r.length - 1]!.w - r[0]!.x,
	x: r[0]!.x,
});
const PRESS_CARD = { x: CX + CW - 22, y: CY + CH - 16 };
const CARD_C = { x: CX + CW / 2, y: CY + CH / 2 };
const SLOT = { x: outCx(0), y: OUT_Y + 7 };

const linkD = `M${PH.x + PH.w} ${PH.y + PH.h / 2} Q${PH.x + PH.w + 14} ${PH.y + PH.h / 2} ${CX} ${CY + CH / 2 - 6}`;

function Card({ t }: { t: number }) {
	const k = spring(t, CARD, 1.7, 0.8);
	if (k <= 0) return null;
	const ox = CX;
	const oy = CY + CH / 2 - 6;
	const s = lerp(0.5, 1, k);
	const approve = smooth((t - APPROVE) / 0.6);
	const m = smooth((t - MORPH) / 0.5);
	const move = smooth((t - MORPH - 0.6) / 1.1);
	const w = lerp(CW, OUT_W, m);
	const h = lerp(CH, 14, m);
	const cx = lerp(CARD_C.x, SLOT.x, move);
	const cy = lerp(CARD_C.y, SLOT.y, move);
	const x0 = cx - w / 2;
	const y0 = cy - h / 2;
	const rowsOp = 1 - clamp(m * 4);
	const doubt = rowSpan(rows[DOUBT]!);
	const rewriteK = smooth((t - REWRITE) / 0.7);
	const rewriteEdge = doubt.x + doubt.w * rewriteK;
	const sweepOp = span(t, REWRITE, REWRITE + 0.7, 0.1, 0.2);
	const typedAt = (i: number) => smooth((t - ROWS1 - i * 0.28) / 0.5);
	const dashOp =
		smooth((t - ROWS1 - 1.1) / 0.4) *
		(1 - smooth((t - REWRITE - 0.1) / 0.4)) *
		(0.55 + 0.45 * Math.sin(t * 6.5));
	const wrongOp = typedAt(DOUBT) * (1 - rewriteK);
	return (
		<g
			opacity={clamp(k * 1.4)}
			transform={
				m > 0
					? undefined
					: `translate(${ox} ${oy}) scale(${s}) translate(${-ox} ${-oy})`
			}
		>
			<rect
				x={x0}
				y={y0}
				width={w}
				height={h}
				rx={lerp(6, 5, m)}
				fill={C.surface}
				stroke={C.quiet}
				strokeWidth={1}
			/>
			{approve > 0.01 && (
				<rect
					x={x0}
					y={y0}
					width={w}
					height={h}
					rx={lerp(6, 5, m)}
					fill={C.successTint}
					stroke={C.success}
					strokeWidth={lerp(1.5, 1.1, m)}
					opacity={approve}
				/>
			)}
			<g opacity={rowsOp}>
				{rows.map((r, i) => {
					const typed = typedAt(i);
					const approved = smooth((t - APPROVE - i * 0.22) / 0.45);
					if (i === DOUBT) {
						return (
							<g key={ROW_Y[i]}>
								{dashOp > 0.01 && (
									<rect
										x={doubt.x - 5}
										y={r[0]!.y - 6}
										width={CW - 14}
										height={16}
										rx={4}
										fill="none"
										stroke={C.text}
										strokeWidth={1.4}
										strokeDasharray="3 2.5"
										strokeDashoffset={-t * 6}
										opacity={dashOp}
									/>
								)}
								{wrongOp > 0.01 &&
									wrong.map((wd) =>
										wd.x > rewriteEdge ? (
											<rect
												key={`${wd.x}-${wd.y}`}
												x={wd.x}
												y={wd.y}
												width={wd.w}
												height={7}
												rx={1.5}
												fill={C.text}
												opacity={0.5 * wrongOp}
											/>
										) : null,
									)}
								<Bars
									words={r}
									k={rewriteK}
									fill={C.muted}
									opacity={0.6 * (1 - approved)}
								/>
								<Bars words={r} k={approved} fill={C.success} opacity={0.9} />{" "}
								{sweepOp > 0.01 && (
									<>
										<line
											x1={rewriteEdge + 5}
											x2={rewriteEdge + 5}
											y1={r[0]!.y - 8}
											y2={r[0]!.y + 12}
											stroke={C.action}
											strokeWidth={2}
											strokeLinecap="round"
											opacity={sweepOp}
										/>
										<Bars
											words={r}
											k={rewriteK}
											fill={C.action}
											opacity={sweepOp}
										/>
									</>
								)}
							</g>
						);
					}
					return (
						<g key={ROW_Y[i]}>
							<Bars
								words={r}
								k={typed}
								fill={C.muted}
								opacity={0.6 * (1 - approved)}
							/>
							<Bars
								words={r}
								k={approved}
								fill={C.success}
								opacity={0.9}
							/>{" "}
						</g>
					);
				})}
			</g>
			{m > 0.5 && (
				<g fill={C.success} opacity={0.9 * clamp((m - 0.5) * 2)}>
					<rect x={x0 + 6} y={y0 + 4} width={w - 16} height={2.6} rx={1.3} />
					<rect x={x0 + 6} y={y0 + 8.4} width={w - 24} height={2.6} rx={1.3} />
				</g>
			)}
		</g>
	);
}

/** Point on the S-shaped link between two points (vertical tangents). */
const flowAt = (
	a: { x: number; y: number },
	b: { x: number; y: number },
	u: number,
) => {
	const ym = (a.y + b.y) / 2;
	const v = 1 - u;
	return {
		x: v ** 3 * a.x + 3 * v * v * u * a.x + 3 * v * u * u * b.x + u ** 3 * b.x,
		y: v ** 3 * a.y + 3 * v * v * u * ym + 3 * v * u * u * ym + u ** 3 * b.y,
	};
};
const linkPath = (a: { x: number; y: number }, b: { x: number; y: number }) =>
	`M${a.x} ${a.y} C${a.x} ${(a.y + b.y) / 2} ${b.x} ${(a.y + b.y) / 2} ${b.x} ${b.y}`;

const ASK = { x: 59, y: 108 };
const REPORT = { x: 190, y: 104 };
const MAP = { x: 270, y: 110 };
const FLOWS = [
	{ at: 22.4, from: 0, to: { x: ASK.x + 16, y: ASK.y - 10 } },
	{ at: 23.0, from: 1, to: { x: ASK.x + 36, y: ASK.y - 10 } },
	{ at: 23.6, from: 2, to: { x: REPORT.x + 18, y: REPORT.y - 10 } },
	{ at: 24.2, from: 3, to: { x: MAP.x + 22, y: MAP.y - 10 } },
];
const FLOW_D = 0.7;
const LIT = {
	ask: [23.1, 23.9],
	map: [24.9, 25.4],
	report: [24.3, 24.9],
} as const;

export const verify: Loop = {
	draw: (t) => {
		const ground = smooth((t - 0.1) / 0.8);
		const linkK = smooth((t - LINK) / 0.45);
		const echoPress = { x: ECHO.cx + 9, y: ECHO.cy + 5 };
		const secondPress = { x: SECOND.cx + 8, y: SECOND.cy + 5 };
		const zoom = smooth((t - ZOOM) / 1.1);
		const closeUp = 1 - smooth((t - ZOOM) / 0.55);
		return (
			<g>
				{closeUp > 0.01 && (
					<g
						opacity={closeUp}
						transform={about(SLOT.x, TABLE_Y + 10, lerp(1, 0.3, zoom))}
					>
						{ground > 0 && (
							<line
								x1={20}
								x2={lerp(20, 236, ground)}
								y1={146}
								y2={146}
								stroke={C.quiet}
								strokeWidth={1}
								strokeLinecap="round"
							/>
						)}
						{PX.map((x, i) => (
							<Person
								key={x}
								x={x}
								y={PERSON_Y}
								k={spring(t, 0.15 + i * 0.15, 1.7, 0.82)}
							/>
						))}
						<Voice x={PX[0]!} y={63} t={t} a={0.95} b={2.25} />
						<Voice x={PX[2]!} y={63} t={t} a={2.3} b={3.5} />
						<Voice x={PX[1]!} y={63} t={t} a={TALK2.a} b={TALK2.b} />

						<PhoneScene t={t} />

						{linkK > 0 && (
							<path
								d={linkD}
								pathLength={1}
								strokeDasharray="1 1"
								strokeDashoffset={1 - linkK}
								fill="none"
								stroke={C.quiet}
								strokeWidth={1.2}
								strokeLinecap="round"
							/>
						)}
						<Ripple x={PRESS_CARD.x} y={PRESS_CARD.y} t={t} tp={TAP_APPROVE} />
						<Fingertip
							a={echoPress}
							b={secondPress}
							ta={TAP_ECHO1}
							tb={TAP_VERIFY}
							t={t}
						/>
						<Fingertip
							a={echoPress}
							b={secondPress}
							ta={TAP_ECHO2}
							tb={TAP_REVISE}
							t={t}
						/>
					</g>
				)}
				<Card t={t} />
				<Fingertip
					a={{ x: PRESS_CARD.x + 8, y: PRESS_CARD.y + 5 }}
					ta={TAP_APPROVE}
					t={t}
				/>

				{TX.map((x, i) => (
					<Table
						key={x}
						x={x}
						y={TABLE_Y}
						t={t}
						k={spring(t, TABLE_IN[i]!, 1.7, 0.82)}
						talk={span(t, TABLE_IN[i]! + 0.2, TABLE_IN[i]! + 1.1)}
					/>
				))}
				{OUT_IN.map((a, i) => {
					if (i === 0) return null;
					const k = spring(t, a, 2.4, 0.5);
					const ring = clamp((t - a) / 0.7);
					return (
						<g key={TX[i]}>
							{ring > 0 && ring < 1 && (
								<rect
									x={outCx(i) - OUT_W / 2 - 3 - ring * 4}
									y={OUT_Y - 3 - ring * 4}
									width={OUT_W + 6 + ring * 8}
									height={20 + ring * 8}
									rx={6 + ring * 3}
									fill="none"
									stroke={C.success}
									strokeWidth={1}
									opacity={0.7 * (1 - ring)}
								/>
							)}
							<Outcome
								x={outCx(i) - OUT_W / 2}
								y={lerp(OUT_Y + 12, OUT_Y, k)}
								k={k}
							/>
						</g>
					);
				})}

				<AskMini
					x={ASK.x}
					y={ASK.y}
					k={spring(t, 22.0, 1.7, 0.82)}
					lit={span(t, LIT.ask[0], LIT.ask[1], 0.12, 0.25)}
				/>
				<ReportMini
					x={REPORT.x}
					y={REPORT.y}
					k={spring(t, 22.1, 1.7, 0.82)}
					lit={span(t, LIT.report[0], LIT.report[1], 0.12, 0.25)}
				/>
				<MapMini
					x={MAP.x}
					y={MAP.y}
					k={spring(t, 22.2, 1.7, 0.82)}
					lit={span(t, LIT.map[0], LIT.map[1], 0.12, 0.25)}
				/>
				{FLOWS.map((f) => {
					const a = { x: outCx(f.from), y: OUT_Y + 22 };
					const grow = smooth((t - 22.25 - f.from * 0.08) / 0.4);
					const u = clamp((t - f.at) / FLOW_D);
					const p = flowAt(a, f.to, smooth(u));
					const vis = smooth((t - f.at) / 0.1) * (1 - smooth((u - 0.7) / 0.3));
					return (
						<g key={f.from}>
							{grow > 0 && (
								<path
									d={linkPath(a, f.to)}
									pathLength={1}
									strokeDasharray="1 1"
									strokeDashoffset={1 - grow}
									fill="none"
									stroke={C.quiet}
									strokeWidth={1.2}
									strokeLinecap="round"
								/>
							)}
							{vis > 0.01 && u < 1 && (
								<g opacity={vis}>
									<Outcome x={p.x - 14} y={p.y - 7} k={1} w={28} />
								</g>
							)}
						</g>
					);
				})}
			</g>
		);
	},
	lines: () => [
		translate`Talk it through at your table.`,
		translate`Tap ECHO, then tap Verify.`,
		translate`Get a summary of your conversation.`,
		translate`Spot a mistake? Discuss and revise.`,
		translate`Approve it when you feel heard.`,
		translate`Every table approves its own outcomes.`,
		translate`Explore them later in the dashboard.`,
	],
	out: 25.8,
	scenes: [0, 3.7, 7.4, 11.1, 14.8, 18.5, 22.2],
	seconds: 26.6,
};
