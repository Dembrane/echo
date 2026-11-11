import type { ReactNode } from "react";
import type { CardKey } from "../projectTemplates";

/**
 * The sixteen room drawings (ECHO-1058): each format seen from above, so the picture tells
 * the formats apart. One grammar for all: a square is a table, a ring is a person, a filled
 * ring is the person who leads (moderator, interviewer, table host, convener), and the one
 * accent, a small blue block, is the phone that records. Drawn on a 160 by 80 grid with
 * thin round strokes, as Phosphor light draws its icons.
 */

/** A person seen from above. */
const P = ({
	x,
	y,
	lead = false,
}: {
	x: number;
	y: number;
	lead?: boolean;
}) => <circle cx={x} cy={y} r={3.5} fill={lead ? "currentColor" : "none"} />;

/** A table, by its centre. */
const T = ({ x, y, w, h }: { x: number; y: number; w: number; h: number }) => (
	<rect x={x - w / 2} y={y - h / 2} width={w} height={h} />
);

/** The phone that records: the one accent. */
const R = ({ x, y }: { x: number; y: number }) => (
	<rect
		x={x - 2}
		y={y - 3}
		width={4}
		height={6}
		fill="var(--app-action)"
		stroke="none"
	/>
);

/** An arrowhead at (x, y) pointing at `deg` (0 is right, 90 is down). */
const Head = ({ x, y, deg }: { x: number; y: number; deg: number }) => (
	<path
		d="M-4 -3.5 L0 0 L-4 3.5"
		transform={`translate(${x} ${y}) rotate(${deg})`}
	/>
);

/** A small table with people above and below it, and its phone. */
const Group4 = ({
	x,
	y,
	w = 28,
	top = 2,
	bottom = 2,
	phone = true,
}: {
	x: number;
	y: number;
	w?: number;
	top?: number;
	bottom?: number;
	phone?: boolean;
}) => {
	const row = (n: number, py: number) =>
		Array.from({ length: n }, (_, i) => {
			const px = x - w / 2 + (w / (n + 1)) * (i + 1);
			return (
				<P
					// biome-ignore lint/suspicious/noArrayIndexKey: fixed drawing
					key={`${py}-${i}`}
					x={px}
					y={py}
				/>
			);
		});
	return (
		<g>
			<T x={x} y={y} w={w} h={12} />
			{row(top, y - 11)}
			{row(bottom, y + 11)}
			{phone ? <R x={x} y={y} /> : null}
		</g>
	);
};

/** People on a circle. */
const ring = (cx: number, cy: number, r: number, n: number, start = -90) =>
	Array.from({ length: n }, (_, i) => {
		const a = ((start + (360 / n) * i) * Math.PI) / 180;
		return (
			<P
				// biome-ignore lint/suspicious/noArrayIndexKey: fixed drawing
				key={i}
				x={Math.round((cx + r * Math.cos(a)) * 10) / 10}
				y={Math.round((cy + r * Math.sin(a)) * 10) / 10}
			/>
		);
	});

export const DRAWINGS: Record<CardKey, () => ReactNode> = {
	// Table conversations: many fixed tables at once, each with its own phone.
	resident_evening: () => (
		<>
			{[32, 80, 128].map((x) =>
				[24, 58].map((y) => <Group4 key={`${x}-${y}`} x={x} y={y} />),
			)}
		</>
	),
	// Round table: one table, everyone at it on equal footing, one phone.
	round_table: () => (
		<>
			<T x={80} y={40} w={52} h={26} />
			{[62, 80, 98].map((x) => (
				<P key={`t${x}`} x={x} y={19} />
			))}
			{[62, 80, 98].map((x) => (
				<P key={`b${x}`} x={x} y={61} />
			))}
			<P x={45} y={40} />
			<P x={115} y={40} />
			<R x={80} y={40} />
		</>
	),
	// Focus group: a long table, a moderator at its head.
	focus_group: () => (
		<>
			<T x={86} y={40} w={64} h={18} />
			{[66, 86, 106].map((x) => (
				<P key={`t${x}`} x={x} y={23} />
			))}
			{[66, 86, 106].map((x) => (
				<P key={`b${x}`} x={x} y={57} />
			))}
			<P x={44} y={40} lead />
			<P x={128} y={40} />
			<R x={86} y={40} />
		</>
	),
	// Interviews: one interviewer, one guest, the next ones waiting.
	interviews: () => (
		<>
			<T x={54} y={40} w={18} h={14} />
			<P x={36} y={40} lead />
			<P x={72} y={40} />
			<R x={54} y={40} />
			<g strokeDasharray="2 2.5">
				<P x={104} y={40} />
				<P x={120} y={40} />
				<P x={136} y={40} />
			</g>
			<path d="M134 26 H96" />
			<Head x={94} y={26} deg={180} />
		</>
	),
	// Kitchen-table conversation: two people at a table, inside a home.
	kitchen_table: () => (
		<>
			<path d="M44 34 L80 10 L116 34 V72 H44 Z" />
			<T x={80} y={52} w={22} h={12} />
			<P x={62} y={52} lead />
			<P x={98} y={52} />
			<R x={80} y={52} />
		</>
	),
	// Strategy session: groups find themes, then agree actions.
	strategy_day: () => (
		<>
			<Group4 x={34} y={22} />
			<Group4 x={34} y={58} />
			<path d="M62 40 H88" />
			<Head x={90} y={40} deg={0} />
			{[24, 40, 56].map((y, i) => (
				<g key={y}>
					<rect x={102} y={y - 4} width={8} height={8} />
					<path d={`M116 ${y} H140`} />
					{i < 2 ? <path d={`M104 ${y} L106 ${y + 2} L109 ${y - 2}`} /> : null}
				</g>
			))}
		</>
	),
	// Recurring meeting: the same table, meeting after meeting, each with its minutes.
	working_group: () => (
		<>
			<T x={60} y={40} w={40} h={18} />
			<P x={50} y={23} />
			<P x={70} y={23} />
			<P x={50} y={57} />
			<P x={70} y={57} />
			<P x={32} y={40} lead />
			<R x={60} y={40} />
			<path d="M112 22 V18 H138 V50 H134" />
			<path d="M106 28 V24 H132 V56 H128" />
			<rect x={100} y={30} width={26} height={32} />
			<path d="M106 38 H120 M106 44 H120 M106 50 H116" />
		</>
	),
	// Retrospective: one team at one table, looking back.
	retrospective: () => (
		<>
			<Group4 x={80} y={40} w={30} />
			<path d="M128 40 A48 30 0 1 0 104 66" />
			<Head x={104} y={66} deg={-12} />
		</>
	),
	// Brainstorm: groups that build on each other's ideas.
	ideation: () => (
		<>
			<g strokeDasharray="2 3">
				<path d="M48 50 L68 32 M92 32 L112 50 M50 62 H110" />
			</g>
			<Group4 x={36} y={58} w={24} top={2} bottom={0} />
			<Group4 x={80} y={22} w={24} top={0} bottom={2} />
			<Group4 x={124} y={58} w={24} top={2} bottom={0} />
			<path d="M80 2 V6 M70 6 L72 9 M90 6 L88 9" />
		</>
	),
	// Scenario session: from one table, futures that part ways.
	futures: () => (
		<>
			<Group4 x={34} y={40} />
			<path d="M48 40 C76 40 84 16 120 16" />
			<path d="M48 40 H120" />
			<path d="M48 40 C76 40 84 64 120 64" />
			<rect x={124} y={12} width={8} height={8} />
			<circle cx={128} cy={40} r={4} />
			<path d="M124 68 L128 60 L132 68 Z" />
		</>
	),
	// Rotating tables: people move between tables, each table host stays.
	world_cafe: () => (
		<>
			{[
				[44, 22],
				[116, 22],
				[44, 60],
				[116, 60],
			].map(([x, y]) => (
				<g key={`${x}-${y}`}>
					<T x={x} y={y} w={20} h={12} />
					<P x={x - 16} y={y} lead />
					<P x={x + 16} y={y} />
					<R x={x} y={y} />
				</g>
			))}
			<path d="M80 29 A12 12 0 0 1 92 41" />
			<Head x={92} y={42} deg={90} />
			<path d="M80 53 A12 12 0 0 1 68 41" />
			<Head x={68} y={40} deg={270} />
		</>
	),
	// Unconference: an open agenda on the wall, groups that form and move.
	open_space: () => (
		<>
			<rect x={50} y={4} width={60} height={22} />
			<path d="M70 4 V26 M90 4 V26 M50 15 H110" />
			{[
				[30, 56],
				[130, 56],
			].map(([x, y]) => (
				<g key={x}>
					{ring(x, y, 10, 3)}
					<R x={x} y={y} />
				</g>
			))}
			<P x={80} y={48} lead />
			<P x={71} y={66} />
			<P x={89} y={66} />
			<R x={80} y={58} />
			<g strokeDasharray="2 2.5">
				<path d="M44 66 C54 74 62 74 68 70" />
			</g>
			<Head x={69} y={69} deg={-30} />
		</>
	),
	// Everyone's ideas, fast: alone, in pairs, in fours, then all together.
	one_two_four_all: () => (
		<>
			<P x={14} y={40} />
			<path d="M22 40 H30" />
			<Head x={32} y={40} deg={0} />
			<P x={40} y={40} />
			<P x={50} y={40} />
			<path d="M58 40 H66" />
			<Head x={68} y={40} deg={0} />
			<P x={76} y={34} />
			<P x={86} y={34} />
			<P x={76} y={46} />
			<P x={86} y={46} />
			<R x={81} y={40} />
			<path d="M94 40 H102" />
			<Head x={104} y={40} deg={0} />
			{ring(136, 40, 18, 8)}
			<R x={136} y={40} />
		</>
	),
	// Calm conversation in rounds: a circle of chairs, each person speaks in turn.
	conversation_cafe: () => (
		<>
			{ring(80, 40, 22, 6)}
			<R x={80} y={40} />
			<path d="M80 6 A34 34 0 0 1 114 40" strokeDasharray="2 3" />
			<Head x={114} y={41} deg={90} />
		</>
	),
	// Citizens' assembly: groups that weigh the options.
	citizens_assembly: () => (
		<>
			<path d="M60 8 H100 M80 4 V8" />
			<path d="M60 8 L54 22 H66 Z M100 8 L94 22 H106 Z" />
			<path d="M80 8 V22 M74 22 H86" />
			{[32, 80, 128].map((x) => (
				<Group4 key={x} x={x} y={56} top={2} bottom={2} />
			))}
		</>
	),
	// Parallel sessions: rooms side by side, a speaker and a phone in each.
	conference: () => (
		<>
			{[30, 80, 130].map((x) => (
				<g key={x}>
					<path d={`M${x - 8} 74 H${x - 20} V6 H${x + 20} V74 H${x + 8}`} />
					<P x={x} y={16} lead />
					<R x={x + 10} y={16} />
					{[x - 10, x, x + 10].map((px) => (
						<P key={`a${px}`} x={px} y={40} />
					))}
					{[x - 10, x, x + 10].map((px) => (
						<P key={`b${px}`} x={px} y={54} />
					))}
				</g>
			))}
		</>
	),
};
