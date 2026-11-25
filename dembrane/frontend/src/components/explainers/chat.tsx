import { t as translate } from "@lingui/core/macro";
// Every value is a pure function of t, so any frame renders on its own and the loop is exact.
import { about, ConvCard, Outcome, ScanLine, span } from "./cast";
import { C, Cursor, clamp, type Loop, lerp, smooth, spring } from "./kit";

// A lo-fi tracing of the real Ask flow: the question box with its chips, the picker, the thread.
const step = (t: number, a: number, d: number) => smooth((t - a) / d);

// Beat 1: the question box (chips above it, select pill and send pill inside).
const BOX = { h: 76, w: 312, x: 24, y: 32 };
// Beat 2: the picker opens, the verified filter narrows it, three rows are ticked.
const PICK = { h: 164, w: 328, x: 16, y: 6 };
const OPEN_AT = 4.7;
const FILTER_AT = 5.6;
const NARROW_AT = 5.75;
const TICK_AT = [6.5, 6.9, 7.3];
const CLOSE_AT = 7.6;
// Beat 3: the picks show by the select pill, the question is typed, Send is pressed.
const CHIPS_AT = 8.2;
const TYPE = [8.9, 10.5] as const;
const SEND_AT = 11.2;
// Beat 4: the question, the picked conversations, dembrane reads them, the answer cites them.
const MORPH = [11.5, 0.7] as const;
const QUESTION = { h: 28, w: 146, x: 190, y: 8 };
const CARD_X = [24, 112, 200];
const CARD_Y = 42;
const CARDS_AT = 12.15;
const SCAN = [12.6, 13.7] as const;
const SCAN_X = [18, 262] as const;
const ANSWER = { h: 72, w: 288, x: 24, y: 92 };
const ANSWER_AT = 13.9;
const ROW1_AT = 14.2;
const LINK_AT = [14.4, 14.6, 14.8];
const OUT = 16.3;

/** 1 while the box and chips are showing, 0 while the picker covers them. */
function coverUnder(t: number) {
	return (
		1 - step(t, 4.66, 0.12) + step(t, CLOSE_AT + 0.33, 0.25) * step(t, 4.9, 0.1)
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
}: {
	x: number;
	y: number;
	w: number;
	k?: number;
	h?: number;
	fill: string;
	opacity: number;
}) {
	const ww = w * clamp(k);
	if (ww < 0.5) return null;
	return (
		<rect
			x={x}
			y={y}
			width={Math.max(ww, h)}
			height={h}
			rx={h / 2}
			fill={fill}
			opacity={opacity * clamp(ww / h)}
		/>
	);
}

/** The small speech-bubble mark of "select conversations". */
function Bubble({ x, y }: { x: number; y: number }) {
	return (
		<circle
			cx={x}
			cy={y}
			r={3.6}
			fill="none"
			stroke={C.text}
			strokeWidth={1}
			opacity={0.8}
		/>
	);
}

/** The template chips above the box, and the settings dot. */
function Chips({ t }: { t: number }) {
	const out = (1 - step(t, 11.2, 0.35)) * clamp(coverUnder(t));
	return (
		<g opacity={out}>
			{[
				{ w: 34, x: 24 },
				{ w: 50, x: 64 },
				{ w: 44, x: 120 },
			].map((c, i) => {
				const k = spring(t, 0.2 + i * 0.12, 1.8);
				if (k <= 0) return null;
				return (
					<g
						key={c.x}
						opacity={clamp(k * 1.4)}
						transform={about(c.x + c.w / 2, 18, lerp(0.7, 1, k))}
					>
						<rect
							x={c.x}
							y={12}
							width={c.w}
							height={12}
							rx={3}
							fill={C.surface}
							stroke={C.quiet}
							strokeWidth={1}
						/>
						<rect
							x={c.x + 7}
							y={16}
							width={c.w - 14}
							height={4}
							rx={2}
							fill={C.muted}
							opacity={0.7}
						/>
					</g>
				);
			})}
			<circle
				cx={180}
				cy={18}
				r={4.5}
				fill="none"
				stroke={C.muted}
				strokeWidth={1}
				opacity={clamp(spring(t, 0.55, 1.8) * 1.4)}
			/>
		</g>
	);
}

/** The question box: the box itself morphs into the question's bubble once Send is pressed. */
function Box({ t }: { t: number }) {
	const grow = spring(t, 0.45, 1.6);
	if (grow <= 0) return null;
	const m = step(t, MORPH[0], MORPH[1]);
	const x = lerp(BOX.x, QUESTION.x, m);
	const y = lerp(BOX.y, QUESTION.y, m);
	const w = lerp(BOX.w, QUESTION.w, m);
	const h = lerp(BOX.h, QUESTION.h, m);
	const inner = clamp(grow * 1.4) * (1 - step(t, 11.4, 0.35));
	const bottom = BOX.y + BOX.h;
	// The select pill: outlined darker while the picker is open.
	const sel = step(t, 4.55, 0.15) * (1 - step(t, CLOSE_AT, 0.4));
	const chips = [0, 1, 2].map((i) => spring(t, CHIPS_AT + i * 0.12, 1.8));
	const ph = lerp(14, 32, step(t, 8.15, 0.3));
	const typed = step(t, TYPE[0], TYPE[1] - TYPE[0]);
	const line1 = clamp(typed / 0.62);
	const line2 = clamp((typed - 0.62) / 0.38);
	const words1 = [
		{ w: 34, x: 0 },
		{ w: 24, x: 40 },
		{ w: 46, x: 70 },
		{ w: 20, x: 122 },
		{ w: 38, x: 148 },
	];
	const words2 = [
		{ w: 40, x: 0 },
		{ w: 26, x: 46 },
		{ w: 18, x: 78 },
	];
	const caretLine = line2 > 0 ? 2 : 1;
	const caretEdge = caretLine === 2 ? 100 * line2 : 186 * line1;
	const blink =
		t < TYPE[1] ? 1 : 0.55 + 0.45 * Math.cos((t - TYPE[1]) * Math.PI * 1.6);
	const caret = step(t, TYPE[0] - 0.25, 0.25) * blink;
	const sendPress =
		step(t, SEND_AT - 0.08, 0.08) * (1 - step(t, SEND_AT, 0.25));
	const asked = step(t, MORPH[0] + 0.3, 0.4);
	// The picker sits on top: the box steps aside as it opens and returns once it has left.
	const under = coverUnder(t);
	return (
		<g
			opacity={clamp(grow * 1.4) * clamp(under)}
			transform={about(
				BOX.x + BOX.w / 2,
				BOX.y + BOX.h / 2,
				lerp(0.92, 1, clamp(grow)),
			)}
		>
			<rect
				x={x}
				y={y}
				width={w}
				height={h}
				rx={6}
				fill={C.surface}
				stroke={C.quiet}
				strokeWidth={1}
			/>
			<g opacity={inner}>
				<rect
					x={BOX.x + 12}
					y={BOX.y + ph}
					width={90}
					height={4}
					rx={2}
					fill={C.muted}
					opacity={0.6 * (1 - step(t, 8.85, 0.2))}
				/>
				{chips.map((k, i) =>
					k <= 0 ? null : (
						<g
							// biome-ignore lint/suspicious/noArrayIndexKey: three fixed chips
							key={i}
							opacity={clamp(k * 1.4)}
							transform={about(
								BOX.x + 29 + i * 44,
								BOX.y + 14,
								lerp(0.7, 1, k),
							)}
						>
							<rect
								x={BOX.x + 10 + i * 44}
								y={BOX.y + 8}
								width={38}
								height={12}
								rx={6}
								fill={C.surface}
								stroke={C.quiet}
								strokeWidth={1}
							/>
							<circle
								cx={BOX.x + 18 + i * 44}
								cy={BOX.y + 14}
								r={2}
								fill={C.text}
							/>
							<rect
								x={BOX.x + 24 + i * 44}
								y={BOX.y + 12.5}
								width={18}
								height={3}
								rx={1.5}
								fill={C.muted}
								opacity={0.7}
							/>
						</g>
					),
				)}
				{words1.map((wd) => (
					<Pill
						key={`a${wd.x}`}
						x={BOX.x + 12 + wd.x}
						y={BOX.y + 32}
						w={wd.w}
						k={(186 * line1 - wd.x) / wd.w}
						fill={C.text}
						opacity={0.85}
					/>
				))}
				{words2.map((wd) => (
					<Pill
						key={`b${wd.x}`}
						x={BOX.x + 12 + wd.x}
						y={BOX.y + 42}
						w={wd.w}
						k={(100 * line2 - wd.x) / wd.w}
						fill={C.text}
						opacity={0.85}
					/>
				))}
				{caret > 0.01 && (
					<line
						x1={BOX.x + 12 + caretEdge + 4}
						x2={BOX.x + 12 + caretEdge + 4}
						y1={BOX.y + (caretLine === 2 ? 38 : 28)}
						y2={BOX.y + (caretLine === 2 ? 50 : 40)}
						stroke={C.text}
						strokeWidth={1.3}
						strokeLinecap="round"
						opacity={caret * (1 - step(t, SEND_AT, 0.2))}
					/>
				)}
				{/* The select pill, bottom left. */}
				<rect
					x={BOX.x + 10}
					y={bottom - 22}
					width={52}
					height={14}
					rx={7}
					fill="none"
					stroke={C.text}
					strokeWidth={1}
					opacity={0.2 + 0.7 * sel}
				/>
				<Bubble x={BOX.x + 20} y={bottom - 15} />
				<rect
					x={BOX.x + 28}
					y={bottom - 16.5}
					width={26}
					height={3}
					rx={1.5}
					fill={C.muted}
					opacity={0.7}
				/>
				{chips[0]! > 0 && (
					<g opacity={clamp(chips[0]! * 1.4)}>
						<rect
							x={BOX.x + 68}
							y={bottom - 21}
							width={14}
							height={12}
							rx={6}
							fill={C.muted}
							opacity={0.3}
						/>
						<rect
							x={BOX.x + 72}
							y={bottom - 16.5}
							width={6}
							height={3}
							rx={1.5}
							fill={C.text}
							opacity={0.85}
						/>
					</g>
				)}
				{/* The send pill, bottom right. */}
				<rect
					x={BOX.x + BOX.w - 54}
					y={bottom - 24}
					width={44}
					height={16}
					rx={8}
					fill={C.text}
					fillOpacity={0.14 * sendPress}
					stroke={C.text}
					strokeWidth={1}
					opacity={0.3 + 0.6 * sendPress}
				/>
				<rect
					x={BOX.x + BOX.w - 46}
					y={bottom - 17.5}
					width={14}
					height={3}
					rx={1.5}
					fill={C.muted}
					opacity={0.8}
				/>
				<path
					d={`M${BOX.x + BOX.w - 27} ${bottom - 19} L${BOX.x + BOX.w - 18} ${bottom - 16} L${BOX.x + BOX.w - 27} ${bottom - 13} L${BOX.x + BOX.w - 25} ${bottom - 16} Z`}
					fill="none"
					stroke={C.text}
					strokeWidth={0.9}
					strokeLinejoin="round"
					opacity={0.8}
				/>
			</g>
			{/* The same question, once it sits in the thread. */}
			<g opacity={asked}>
				{[
					{ w: 26, x: 0 },
					{ w: 20, x: 30 },
					{ w: 34, x: 54 },
					{ w: 16, x: 92 },
				].map((wd) => (
					<Pill
						key={`q${wd.x}`}
						x={QUESTION.x + 12 + wd.x}
						y={QUESTION.y + 9}
						w={wd.w}
						fill={C.text}
						opacity={0.85}
					/>
				))}
				{[
					{ w: 34, x: 0 },
					{ w: 22, x: 38 },
				].map((wd) => (
					<Pill
						key={`r${wd.x}`}
						x={QUESTION.x + 12 + wd.x}
						y={QUESTION.y + 17}
						w={wd.w}
						fill={C.text}
						opacity={0.85}
					/>
				))}
			</g>
		</g>
	);
}

/** The rows of the picker: tick square, title, two grey lines, and the outcome of verified ones. */
const ROWS = [
	{ outcome: false, title: 46 },
	{ outcome: true, title: 38 },
	{ outcome: false, title: 52 },
	{ outcome: true, title: 42 },
	{ outcome: true, title: 34 },
];
const ROW0 = PICK.y + 46;
const PITCH = 22;

/** The picker box: filter on top (a verified toggle), the list below; opens over the select pill. */
function Picker({ t }: { t: number }) {
	const open = spring(t, OPEN_AT, 1.8);
	const close = step(t, CLOSE_AT, 0.4);
	const k = clamp(open) * (1 - close);
	if (k <= 0.005) return null;
	const px = PICK.x;
	const py = PICK.y;
	const on = step(t, FILTER_AT, 0.2);
	const narrow = step(t, NARROW_AT, 0.55);
	let slot = 0;
	return (
		<g
			opacity={clamp(open * 1.5) * (1 - close)}
			transform={`translate(0 ${lerp(8, 0, k)})`}
		>
			<rect
				x={px}
				y={py}
				width={PICK.w}
				height={PICK.h}
				rx={8}
				fill={C.surface}
				stroke={C.quiet}
				strokeWidth={1}
			/>
			<rect
				x={px + 14}
				y={py + 10}
				width={60}
				height={5}
				rx={2.5}
				fill={C.text}
				opacity={0.85}
			/>
			<path
				d={`M${px + PICK.w - 22} ${py + 9} l8 8 M${px + PICK.w - 14} ${py + 9} l-8 8`}
				stroke={C.muted}
				strokeWidth={1.2}
				strokeLinecap="round"
			/>
			{/* Filter row: search, sort, and the verified toggle. */}
			<rect
				x={px + 14}
				y={py + 26}
				width={84}
				height={14}
				rx={4}
				fill="none"
				stroke={C.quiet}
				strokeWidth={1}
			/>
			<circle
				cx={px + 23}
				cy={py + 33}
				r={2.6}
				fill="none"
				stroke={C.muted}
				strokeWidth={1}
			/>
			<rect
				x={px + 30}
				y={py + 31.5}
				width={30}
				height={3}
				rx={1.5}
				fill={C.muted}
				opacity={0.5}
			/>
			<rect
				x={px + 104}
				y={py + 26}
				width={52}
				height={14}
				rx={4}
				fill="none"
				stroke={C.quiet}
				strokeWidth={1}
			/>
			<rect
				x={px + 111}
				y={py + 31.5}
				width={24}
				height={3}
				rx={1.5}
				fill={C.muted}
				opacity={0.5}
			/>
			<rect
				x={px + PICK.w - 64}
				y={py + 26}
				width={20}
				height={10}
				rx={5}
				fill={C.text}
				fillOpacity={on}
				stroke={C.text}
				strokeWidth={1}
				opacity={lerp(0.4, 0.9, on)}
				transform="translate(0 5)"
			/>
			<circle
				cx={px + PICK.w - 59 + 10 * on}
				cy={py + 36}
				r={3.4}
				fill={on > 0.5 ? C.surface : C.muted}
			/>
			<rect
				x={px + PICK.w - 38}
				y={py + 34.5}
				width={26}
				height={3}
				rx={1.5}
				fill={C.muted}
				opacity={0.7}
			/>
			{ROWS.map((row, i) => {
				const pos = row.outcome ? slot : i;
				const place = row.outcome ? lerp(i, slot, narrow) : i;
				if (row.outcome) slot += 1;
				const ry = ROW0 + place * PITCH;
				const vis = row.outcome ? 1 : 1 - step(t, NARROW_AT, 0.3);
				const tick = row.outcome ? step(t, TICK_AT[pos]!, 0.15) : 0;
				const press =
					row.outcome && t > TICK_AT[pos]! - 0.08 && t < TICK_AT[pos]! + 0.12;
				return (
					<g key={`row-${row.title}`} opacity={vis}>
						<line
							x1={px + 10}
							x2={px + PICK.w - 10}
							y1={ry - 2}
							y2={ry - 2}
							stroke={C.quiet}
							strokeWidth={1}
						/>
						<rect
							x={px + 14}
							y={ry + 3}
							width={8}
							height={8}
							rx={2}
							fill={C.text}
							fillOpacity={0.9 * tick}
							stroke={C.text}
							strokeWidth={1}
							opacity={lerp(0.45, 1, tick)}
							transform={press ? "translate(0 0.4)" : undefined}
						/>
						<rect
							x={px + 28}
							y={ry + 2}
							width={row.title}
							height={4}
							rx={2}
							fill={C.text}
							opacity={0.8}
						/>
						<rect
							x={px + 28}
							y={ry + 9}
							width={150}
							height={3}
							rx={1.5}
							fill={C.muted}
							opacity={0.55}
						/>
						<rect
							x={px + 28}
							y={ry + 14}
							width={104}
							height={3}
							rx={1.5}
							fill={C.muted}
							opacity={0.55}
						/>
						{row.outcome && (
							<Outcome x={px + PICK.w - 14 - 34} y={ry + 2} k={1} w={34} />
						)}
					</g>
				);
			})}
		</g>
	);
}

/** The pointer: follows its keyframes with an eased glide between each, pressing on the beats. */
const PATH: { t: number; x: number; y: number }[] = [
	{ t: 3.5, x: 150, y: 190 },
	{ t: 4.5, x: 46, y: 94 },
	{ t: 5.0, x: 46, y: 94 },
	{ t: 5.5, x: 290, y: 41 },
	{ t: 5.85, x: 290, y: 41 },
	{ t: 6.4, x: 34, y: 59 },
	{ t: 6.6, x: 34, y: 59 },
	{ t: 6.85, x: 34, y: 81 },
	{ t: 7.0, x: 34, y: 81 },
	{ t: 7.25, x: 34, y: 103 },
	{ t: 7.5, x: 34, y: 103 },
	{ t: 10.2, x: 210, y: 156 },
	{ t: 11.1, x: 306, y: 94 },
	{ t: 11.4, x: 306, y: 94 },
];
const PRESSES = [4.6, FILTER_AT, ...TICK_AT, SEND_AT];

function Pointer({ t }: { t: number }) {
	let p = PATH[0]!;
	for (let i = 1; i < PATH.length; i++) {
		const a = PATH[i - 1]!;
		const b = PATH[i]!;
		if (t >= a.t && t < b.t) {
			const k = smooth((t - a.t) / (b.t - a.t));
			p = { t, x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k) };
		} else if (t >= b.t) p = b;
	}
	const opacity = span(t, 3.5, 7.9, 0.3, 0.3) + span(t, 10.2, 11.7, 0.3, 0.3);
	const press = PRESSES.some((a) => t > a - 0.08 && t < a + 0.1);
	return <Cursor x={p.x} y={p.y} opacity={clamp(opacity)} press={press} />;
}

/** dembrane's answer: a card whose grey rows write in, with a small citation mark where it leans on a pick. */
function Answer({ t }: { t: number }) {
	const k = spring(t, ANSWER_AT, 1.5);
	if (k <= 0) return null;
	const cx = ANSWER.x + ANSWER.w / 2;
	const cy = ANSWER.y + ANSWER.h / 2;
	const edge = lerp(36, 300, step(t, ROW1_AT, 0.7));
	const segs = [
		{ w: 14, x: 36 },
		{ w: 76, x: 62 },
		{ w: 76, x: 150 },
		{ w: 62, x: 238 },
	];
	const rows = [250, 200, 120];
	return (
		<g
			opacity={clamp(k)}
			transform={`translate(${cx} ${cy}) scale(${0.94 + 0.06 * k}) translate(${-cx} ${-cy})`}
		>
			<rect
				x={ANSWER.x}
				y={ANSWER.y}
				width={ANSWER.w}
				height={ANSWER.h}
				rx={6}
				fill={C.surface}
				stroke={C.quiet}
				strokeWidth={1}
			/>
			{segs.map((s) => (
				<Pill
					key={`s${s.x}`}
					x={s.x}
					y={ANSWER.y + 12}
					w={s.w}
					k={(edge - s.x) / s.w}
					fill={C.muted}
					opacity={0.7}
				/>
			))}
			{rows.map((w, r) => (
				<Pill
					key={`w${w}`}
					x={36}
					y={ANSWER.y + 24 + r * 12}
					w={w}
					k={step(t, 14.7 + r * 0.22, 0.5)}
					fill={C.muted}
					opacity={0.7}
				/>
			))}
		</g>
	);
}

const MARK_Y = ANSWER.y + 11;
/** The citation marks sit in the first row; a blue link ties each one up to the pick it leans on. */
function Citations({ t }: { t: number }) {
	const edge = lerp(36, 300, step(t, ROW1_AT, 0.7));
	return (
		<g>
			{CARD_X.map((x, i) => {
				const c = x + 32;
				const pop = clamp((edge - c) / 10);
				const link = step(t, LINK_AT[i]!, 0.45);
				return (
					<g key={x}>
						{link > 0.001 && (
							<path
								d={`M ${c} 85 L ${c} ${MARK_Y - 1}`}
								pathLength={1}
								strokeDasharray="1 1"
								strokeDashoffset={1 - link}
								stroke={C.action}
								strokeWidth={1.5}
								strokeLinecap="round"
								fill="none"
							/>
						)}
						{pop > 0.01 && (
							<rect
								x={c - 4}
								y={MARK_Y}
								width={8}
								height={6}
								rx={3}
								fill={C.action}
								opacity={pop * step(t, ANSWER_AT + 0.3, 0.2)}
								transform={about(c, MARK_Y + 3, lerp(0.5, 1, pop))}
							/>
						)}
					</g>
				);
			})}
		</g>
	);
}

/** The picked conversations in the thread: the same cards, with the outcomes that were verified. */
function Picks({ t }: { t: number }) {
	const sx = lerp(
		SCAN_X[0],
		SCAN_X[1],
		smooth((t - SCAN[0]) / (SCAN[1] - SCAN[0])),
	);
	const o = step(t, SCAN[0] - 0.1, 0.25) * (1 - step(t, SCAN[1] - 0.15, 0.3));
	return (
		<g>
			{CARD_X.map((x, i) => (
				<ConvCard
					key={x}
					x={x}
					y={CARD_Y}
					k={spring(t, CARDS_AT + i * 0.15, 1.6)}
					lit={smooth((sx - (x + 22)) / 12) * (1 - step(t, SCAN[1], 0.5))}
					outcome={spring(t, CARDS_AT + 0.2 + i * 0.15, 1.6)}
				/>
			))}
			<ScanLine x={sx} y1={CARD_Y - 4} y2={CARD_Y + 44} opacity={o} />
		</g>
	);
}

export const chat: Loop = {
	draw: (t) => {
		// Reaches zero just before the loop's last frame, so the last frame matches the first exactly.
		const gone = 1 - step(t, OUT, 0.5);
		return (
			<g opacity={gone}>
				<Chips t={t} />
				<Box t={t} />
				<Picker t={t} />
				<Picks t={t} />
				<Answer t={t} />
				<Citations t={t} />
				<Pointer t={t} />
			</g>
		);
	},
	lines: () => [
		translate`Ask about your conversations.`,
		translate`Select the conversations that matter.`,
		translate`Type your question and send it.`,
		translate`The answer cites those conversations.`,
	],
	out: OUT,
	scenes: [0, 4, 8, 12],
	seconds: 17,
};
export default chat;
