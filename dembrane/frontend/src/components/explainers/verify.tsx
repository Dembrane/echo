import { t as translate } from "@lingui/core/macro";
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

/** Fade in at a over d, then out at b over e. */
const span = (t: number, a: number, b: number, d = 0.3, e = 0.3) =>
	smooth((t - a) / d) * (1 - smooth((t - b) / e));

function Person({ x, k }: { x: number; k: number }) {
	if (k <= 0) return null;
	const y = PERSON_Y;
	const s = lerp(0.6, 1, k);
	return (
		<g
			fill="none"
			stroke={C.text}
			strokeWidth={1.5}
			strokeLinecap="round"
			strokeLinejoin="round"
			opacity={clamp(k * 1.4)}
			transform={`translate(${x} ${y}) scale(${s}) translate(${-x} ${-y})`}
		>
			<circle cx={x} cy={y - 14} r={7} />
			<path
				d={`M${x - 13} ${y + 14} Q${x - 13} ${y} ${x} ${y} Q${x + 13} ${y} ${x + 13} ${y + 14}`}
			/>
		</g>
	);
}

/** A person speaking: wave bars that grow in, breathe gently while they talk, and settle away. */
function Voice({ x, t, a, b }: { x: number; t: number; a: number; b: number }) {
	const grow =
		clamp(spring(t, a, 2, 0.85), 0, 1.06) * (1 - smooth((t - b) / 0.45));
	if (grow <= 0.01) return null;
	const hs = [8, 16, 11, 18, 9];
	const y = 54;
	return (
		<g fill={C.text} opacity={0.7 * smooth(grow * 1.6)}>
			{hs.map((h, i) => {
				const live = h * grow * (0.72 + 0.28 * Math.sin(t * 4.2 + i * 1.3));
				const hh = live;
				if (hh < 0.5) return null;
				return (
					<rect
						key={`${x}-${h}-${hs.indexOf(h)}`}
						x={x - 14 + i * 6}
						y={y + 9 - hh / 2}
						width={3}
						height={hh}
						rx={1.5}
					/>
				);
			})}
		</g>
	);
}

const about = (cx: number, cy: number, k: number) =>
	`translate(${cx} ${cy}) scale(${k}) translate(${-cx} ${-cy})`;

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
const TAP_ECHO1 = 4.3;
const SECOND_IN1 = 4.65;
const TAP_VERIFY = 5.55;
const SECOND_OUT1 = 6.5;
const SCAN1 = { a: 6.0, d: 1.5 };
const CARD = 7.3;
const LINK = 7.2;
const ROWS1 = 7.6;
const TALK2 = { a: 8.6, b: 9.7 };
const TAP_ECHO2 = 9.85;
const SECOND_IN2 = 10.2;
const TAP_REVISE = 10.85;
const SECOND_OUT2 = 11.6;
const SCAN2 = { a: 11.2, d: 0.7 };
const REWRITE = 12.4;
const TAP_APPROVE = 13.8;
const APPROVE = 13.9;

/** Blue while someone talks: the recording dot. */
const talkBlue = (t: number) =>
	Math.max(
		span(t, 1.05, 3.6, 0.25, 0.3),
		span(t, TALK2.a + 0.1, TALK2.b, 0.25, 0.3),
	);

/** 0 to 1 along the scan: the line crosses the waveform left to right. */
const scanX = (t: number, s: { a: number; d: number }) =>
	lerp(PCX - 16, PCX + 16, smooth((t - s.a) / s.d));
const scanLine = (t: number, s: { a: number; d: number }) =>
	smooth((t - s.a) / 0.15) * (1 - smooth((t - s.a - s.d + 0.1) / 0.2));
/** How blue the waveform is: lit as the line passes, held, then back to grey over 0.5 s. */
const litHold = (t: number, s: { a: number; d: number }) =>
	1 - smooth((t - s.a - s.d - 0.3) / 0.5);

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
	const pad = 2 + (1 - (1 - k) ** 2) * 7;
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
			opacity={(1 - k) * 0.55}
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

// The read-back card: three short rows, shorter than the talk, so it reads as "what you meant".
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
const rowSpan = (r: Word[]) => ({
	w: r[r.length - 1]!.x + r[r.length - 1]!.w - r[0]!.x,
	x: r[0]!.x,
});
const PRESS_CARD = { x: CX + CW - 22, y: CY + CH - 16 };

const linkD = `M${PH.x + PH.w} ${PH.y + PH.h / 2} Q${PH.x + PH.w + 14} ${PH.y + PH.h / 2} ${CX} ${CY + CH / 2 - 6}`;

function Card({ t }: { t: number }) {
	const k = spring(t, CARD, 1.7, 0.8);
	if (k <= 0) return null;
	const ox = CX;
	const oy = CY + CH / 2 - 6;
	const s = lerp(0.5, 1, k);
	const blue = smooth((t - APPROVE) / 0.35);
	const doubt = rowSpan(rows[DOUBT]!);
	const rewriteK = smooth((t - REWRITE) / 0.75);
	const rewriteEdge = doubt.x + doubt.w * rewriteK;
	const sweepOp = span(t, REWRITE, REWRITE + 0.85, 0.15, 0.25);
	return (
		<g
			opacity={clamp(k * 1.4)}
			transform={`translate(${ox} ${oy}) scale(${s}) translate(${-ox} ${-oy})`}
		>
			<rect
				x={CX}
				y={CY}
				width={CW}
				height={CH}
				rx={6}
				fill={C.surface}
				stroke={C.quiet}
				strokeWidth={1}
			/>
			{blue > 0.01 && (
				<rect
					x={CX}
					y={CY}
					width={CW}
					height={CH}
					rx={6}
					fill="none"
					stroke={C.action}
					strokeWidth={1.5}
					opacity={clamp(blue)}
				/>
			)}
			{rows.map((r, i) => {
				const typed = smooth((t - ROWS1 - i * 0.28) / 0.5);
				const approved = smooth((t - APPROVE - i * 0.22) / 0.45);
				if (i === DOUBT) {
					const dashOp = 0.7 * (1 - smooth((t - REWRITE) / 0.5));
					return (
						<g key={ROW_Y[i]}>
							{typed > 0.01 && dashOp > 0.01 && (
								<rect
									x={doubt.x}
									y={r[0]!.y - 1}
									width={Math.max(6, doubt.w * typed)}
									height={6}
									rx={3}
									fill="none"
									stroke={C.text}
									strokeWidth={1}
									strokeDasharray="3 2.5"
									opacity={dashOp}
								/>
							)}
							<Bars
								words={r}
								k={rewriteK}
								fill={C.muted}
								opacity={0.6 * (1 - approved)}
							/>
							<Bars words={r} k={approved} fill={C.text} opacity={0.85} />
							{sweepOp > 0.01 && (
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
						<Bars words={r} k={approved} fill={C.text} opacity={0.85} />
					</g>
				);
			})}
		</g>
	);
}

export const verify: Loop = {
	draw: (t) => {
		const ground = smooth((t - 0.1) / 0.8);
		const linkK = smooth((t - LINK) / 0.45);
		const echoPress = { x: ECHO.cx + 9, y: ECHO.cy + 5 };
		const secondPress = { x: SECOND.cx + 8, y: SECOND.cy + 5 };
		return (
			<g>
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
					<Person key={x} x={x} k={spring(t, 0.15 + i * 0.15, 1.7, 0.82)} />
				))}
				<Voice x={PX[0]!} t={t} a={0.95} b={2.25} />
				<Voice x={PX[2]!} t={t} a={2.3} b={3.6} />
				<Voice x={PX[1]!} t={t} a={TALK2.a} b={TALK2.b} />

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
				<Card t={t} />

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
				<Fingertip
					a={{ x: PRESS_CARD.x + 8, y: PRESS_CARD.y + 5 }}
					ta={TAP_APPROVE}
					t={t}
				/>
			</g>
		);
	},
	lines: () => [
		translate`Talk it through together.`,
		translate`Tap ECHO, then Verify.`,
		translate`Not quite? Talk more, tap Revise.`,
		translate`When it's right, approve it.`,
	],
	out: 15.3,
	scenes: [0, 4, 8, 12],
	seconds: 16,
};
