import { C, clamp, lerp, smooth, spring } from "./kit";

/**
 * The shared cast of every explainer loop, so the loops read as one story: a table of people with
 * the phone that records them, the conversation card that recording becomes in the dashboard, and
 * the approved outcome a table verified. A loop draws these, never its own variant.
 */

export const about = (cx: number, cy: number, k: number) =>
	`translate(${cx} ${cy}) scale(${k}) translate(${-cx} ${-cy})`;

/** Fade in at a over d, then out at b over e. */
export const span = (t: number, a: number, b: number, d = 0.3, e = 0.3) =>
	smooth((t - a) / d) * (1 - smooth((t - b) / e));

/** A person: a head over a rounded shoulder arc, graphite, growing in with k. (x, y) is the shoulder top. */
export function Person({
	x,
	y,
	k,
	s = 1,
}: {
	x: number;
	y: number;
	k: number;
	s?: number;
}) {
	if (k <= 0) return null;
	return (
		<g
			fill="none"
			stroke={C.text}
			strokeWidth={1.5 / Math.sqrt(s)}
			strokeLinecap="round"
			strokeLinejoin="round"
			opacity={clamp(k * 1.4)}
			transform={about(x, y, lerp(0.6, 1, k) * s)}
		>
			<circle cx={x} cy={y - 14} r={7} />
			<path
				d={`M${x - 13} ${y + 14} Q${x - 13} ${y} ${x} ${y} Q${x + 13} ${y} ${x + 13} ${y + 14}`}
			/>
		</g>
	);
}

const VOICE = [8, 16, 11, 18, 9].map((h, i) => ({ h, i }));
/** A voice: five wave bars centred on (x, y) that grow in at a, breathe, and settle by b. */
export function Voice({
	x,
	y,
	t,
	a,
	b,
	s = 1,
	fill = C.text,
}: {
	x: number;
	y: number;
	t: number;
	a: number;
	b: number;
	s?: number;
	fill?: string;
}) {
	const grow =
		clamp(spring(t, a, 2, 0.85), 0, 1.06) * (1 - smooth((t - b) / 0.45));
	if (grow <= 0.01) return null;
	return (
		<g fill={fill} opacity={0.7 * smooth(grow * 1.6)}>
			{VOICE.map(({ h, i }) => {
				const hh = h * s * grow * (0.72 + 0.28 * Math.sin(t * 4.2 + i * 1.3));
				if (hh < 0.5) return null;
				return (
					<rect
						key={`v${i}`}
						x={x + (i - 2) * 6 * s - 1.5 * s}
						y={y - hh / 2}
						width={3 * s}
						height={hh}
						rx={1.5 * s}
					/>
				);
			})}
		</g>
	);
}

/**
 * A small table, for the beats where many tables work at once: three heads in a row with the
 * phone that records them beside it. `talk` (0..1) makes the phone's waveform breathe; `lit`
 * (0..1) turns that waveform blue, for a scan or a catch; `dot` turns the recording dot blue.
 */
export function Table({
	x,
	y,
	t,
	k,
	talk = 0,
	lit = 0,
	dot = 0,
}: {
	x: number;
	y: number;
	t: number;
	k: number;
	talk?: number;
	lit?: number;
	dot?: number;
}) {
	if (k <= 0) return null;
	const px = x + 34;
	return (
		<g opacity={clamp(k * 1.4)} transform={about(x + 14, y, lerp(0.6, 1, k))}>
			{[0, 1, 2].map((i) => (
				<Person key={`p${i}`} x={x + i * 13} y={y} k={1} s={0.45} />
			))}
			<rect
				x={px}
				y={y - 16}
				width={14}
				height={26}
				rx={4}
				fill={C.surface}
				stroke={C.text}
				strokeWidth={1.2}
			/>
			<circle
				cx={px + 7}
				cy={y - 11}
				r={1.4}
				fill={dot > 0.01 ? C.action : C.muted}
				opacity={dot > 0.01 ? dot : 0.7}
			/>
			{TABLE_WAVE.map(({ h, i }) => {
				const hh = h * (0.45 + 0.55 * talk * (0.7 + 0.3 * Math.sin(t * 4 + i)));
				return (
					<rect
						key={`w${i}`}
						x={px + 2.6 + i * 2.5}
						y={y - 3 - hh / 2}
						width={1.6}
						height={hh}
						rx={0.8}
						fill={lit > 0.01 ? C.action : C.muted}
						opacity={lit > 0.01 ? lit : 0.8}
					/>
				);
			})}
		</g>
	);
}

const TABLE_WAVE = [3, 6, 4, 5].map((h, i) => ({ h, i }));

export const CARD = { h: 24, w: 64 };
/**
 * A conversation in the dashboard: a rounded card with a small head and two grey bars. `lit`
 * (0..1) turns the bars blue (a scan passing), `picked` outlines it in graphite, `faded` dims
 * what was not chosen, `outcome` (0..1) grows the approved outcome under it (see Outcome).
 */
export function ConvCard({
	x,
	y,
	k,
	lit = 0,
	picked = 0,
	faded = 0,
	outcome = 0,
}: {
	x: number;
	y: number;
	k: number;
	lit?: number;
	picked?: number;
	faded?: number;
	outcome?: number;
}) {
	if (k <= 0) return null;
	const cx = x + CARD.w / 2;
	const cy = y + CARD.h / 2;
	const bar = (by: number, w: number) => (
		<g>
			<rect
				x={x + 22}
				y={by}
				width={w}
				height={4}
				rx={2}
				fill={C.muted}
				opacity={0.6 * (1 - lit)}
			/>
			{lit > 0.01 && (
				<rect
					x={x + 22}
					y={by}
					width={w}
					height={4}
					rx={2}
					fill={C.action}
					opacity={lit}
				/>
			)}
		</g>
	);
	return (
		<g
			opacity={clamp(k * 1.4) * lerp(1, 0.25, faded)}
			transform={about(cx, cy, lerp(0.6, 1, k))}
		>
			<rect
				x={x}
				y={y}
				width={CARD.w}
				height={CARD.h}
				rx={6}
				fill={C.surface}
				stroke={picked > 0.01 ? C.text : C.quiet}
				strokeWidth={lerp(1, 1.5, picked)}
			/>
			<g fill="none" stroke={C.text} strokeWidth={1.1} strokeLinecap="round">
				<circle cx={x + 11} cy={y + 9} r={3.2} />
				<path
					d={`M${x + 5} ${y + 19} Q${x + 5} ${y + 13.5} ${x + 11} ${y + 13.5} Q${x + 17} ${y + 13.5} ${x + 17} ${y + 19}`}
				/>
			</g>
			{bar(y + 7, 32)}
			{bar(y + 14, 22)}
			<Outcome x={x + 8} y={y + CARD.h + 3} k={outcome} />
		</g>
	);
}

/**
 * An approved outcome: what a table verified. Green, the product's colour for approved, because
 * people approved it (the same card Verify ends on, in miniature).
 */
export function Outcome({
	x,
	y,
	k,
	w = 40,
}: {
	x: number;
	y: number;
	k: number;
	w?: number;
}) {
	if (k <= 0.01) return null;
	return (
		<g
			opacity={clamp(k * 1.4)}
			transform={about(x + w / 2, y, lerp(0.5, 1, k))}
		>
			<rect
				x={x}
				y={y}
				width={w}
				height={14}
				rx={5}
				fill={C.successTint}
				stroke={C.success}
				strokeWidth={1.1}
			/>
			<rect
				x={x + 6}
				y={y + 4}
				width={w - 16}
				height={2.6}
				rx={1.3}
				fill={C.success}
				opacity={0.9}
			/>
			<rect
				x={x + 6}
				y={y + 8.4}
				width={w - 24}
				height={2.6}
				rx={1.3}
				fill={C.success}
				opacity={0.9}
			/>
		</g>
	);
}

/** The scan: 0..1 progress of the line between a and a + d. */
export const scanK = (t: number, a: number, d: number) => smooth((t - a) / d);
/** How blue a thing at position p is once the scan line at sx has passed it; settles after `off`. */
export const litBy = (sx: number, p: number, t: number, off: number) =>
	smooth((sx - p) / 12) * (1 - smooth((t - off) / 0.5));
/** The scan line itself: thin, blue, round caps. Vertical by default. */
export function ScanLine({
	x,
	y1,
	y2,
	opacity,
}: {
	x: number;
	y1: number;
	y2: number;
	opacity: number;
}) {
	if (opacity <= 0.01) return null;
	return (
		<line
			x1={x}
			x2={x}
			y1={y1}
			y2={y2}
			stroke={C.action}
			strokeWidth={2}
			strokeLinecap="round"
			opacity={opacity}
		/>
	);
}

/**
 * Where verified outcomes and ideas go next, each drawn as the end state of its own loop, small:
 * Ask (the question box with its send pill), Report (a page of rows under a title), Map (ideas
 * joined by curved links). `lit` (0..1) outlines one in blue when something arrives.
 */
export function AskMini({
	x,
	y,
	k,
	lit = 0,
}: {
	x: number;
	y: number;
	k: number;
	lit?: number;
}) {
	if (k <= 0.01) return null;
	return (
		<g
			opacity={clamp(k * 1.4)}
			transform={about(x + 26, y + 11, lerp(0.6, 1, k))}
		>
			<rect
				x={x}
				y={y}
				width={52}
				height={22}
				rx={6}
				fill={C.surface}
				stroke={lit > 0.01 ? C.action : C.quiet}
				strokeWidth={lit > 0.01 ? 1.5 : 1}
			/>
			<rect
				x={x + 6}
				y={y + 6}
				width={26}
				height={3}
				rx={1.5}
				fill={C.muted}
				opacity={0.6}
			/>
			<rect
				x={x + 5}
				y={y + 14}
				width={12}
				height={4}
				rx={2}
				fill="none"
				stroke={C.muted}
				strokeWidth={0.8}
			/>
			<rect
				x={x + 36}
				y={y + 13}
				width={12}
				height={6}
				rx={3}
				fill="none"
				stroke={C.muted}
				strokeWidth={0.9}
			/>
		</g>
	);
}

export function ReportMini({
	x,
	y,
	k,
	lit = 0,
}: {
	x: number;
	y: number;
	k: number;
	lit?: number;
}) {
	if (k <= 0.01) return null;
	return (
		<g
			opacity={clamp(k * 1.4)}
			transform={about(x + 18, y + 22, lerp(0.6, 1, k))}
		>
			<rect
				x={x}
				y={y}
				width={36}
				height={44}
				rx={6}
				fill={C.surface}
				stroke={lit > 0.01 ? C.action : C.quiet}
				strokeWidth={lit > 0.01 ? 1.5 : 1}
			/>
			<rect
				x={x + 6}
				y={y + 7}
				width={18}
				height={3.5}
				rx={1.75}
				fill={C.text}
				opacity={0.8}
			/>
			{[15, 21, 27, 33].map((ry) => (
				<rect
					key={`r${ry}`}
					x={x + 6}
					y={y + ry}
					width={ry === 27 ? 16 : 24}
					height={2.6}
					rx={1.3}
					fill={C.muted}
					opacity={0.6}
				/>
			))}
		</g>
	);
}

export function MapMini({
	x,
	y,
	k,
	lit = 0,
}: {
	x: number;
	y: number;
	k: number;
	lit?: number;
}) {
	if (k <= 0.01) return null;
	const nodes = [
		{ id: "a", nx: x + 6, ny: y + 8 },
		{ id: "b", nx: x + 26, ny: y + 4 },
		{ id: "c", nx: x + 16, ny: y + 24 },
		{ id: "d", nx: x + 38, ny: y + 22 },
	];
	const stroke = lit > 0.01 ? C.action : C.quiet;
	return (
		<g
			opacity={clamp(k * 1.4)}
			transform={about(x + 22, y + 16, lerp(0.6, 1, k))}
		>
			<path
				d={`M${x + 12} ${y + 10} Q${x + 18} ${y + 2} ${x + 24} ${y + 6} M${x + 12} ${y + 12} Q${x + 12} ${y + 20} ${x + 16} ${y + 22} M${x + 24} ${y + 24} Q${x + 32} ${y + 28} ${x + 34} ${y + 24}`}
				fill="none"
				stroke={stroke}
				strokeWidth={1}
				strokeLinecap="round"
			/>
			{nodes.map((n) => (
				<rect
					key={n.id}
					x={n.nx - 6}
					y={n.ny - 3}
					width={12}
					height={6}
					rx={3}
					fill={C.surface}
					stroke={stroke}
					strokeWidth={1}
				/>
			))}
		</g>
	);
}
