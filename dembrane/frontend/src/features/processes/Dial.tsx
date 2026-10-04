import { roles } from "@/colors";

const STROKE = 1.5;
// The slow arc of work without a count: a fifth of the ring.
const SEGMENT = 0.22;

/** A ring round a rail icon whose blue arc is the work done so far. Without
 * a count the arc turns slowly; with reduced motion it stands still as a
 * dashed ring. Centred on its (relative) parent, drawn over nothing. */
export const Dial = ({
	size,
	done,
	total,
}: {
	size: number;
	done?: number;
	total?: number;
}) => {
	const r = size / 2 - STROKE / 2;
	const length = 2 * Math.PI * r;
	const counted = total != null && total > 0;
	const fraction = counted ? Math.min(1, (done ?? 0) / total) : SEGMENT;
	const circle = { cx: size / 2, cy: size / 2, fill: "none", r };

	return (
		<svg
			aria-hidden="true"
			data-testid="process-dial"
			data-counted={counted || undefined}
			width={size}
			height={size}
			viewBox={`0 0 ${size} ${size}`}
			className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 -rotate-90"
		>
			<circle {...circle} stroke="var(--app-rule-color)" strokeWidth={STROKE} />
			<circle
				{...circle}
				stroke={roles.action}
				strokeWidth={STROKE}
				strokeDasharray={`${length * fraction} ${length}`}
				className={
					counted
						? undefined
						: "origin-center [transform-box:fill-box] motion-safe:animate-[spin_3s_linear_infinite] motion-reduce:hidden"
				}
			/>
			{counted ? null : (
				<circle
					{...circle}
					stroke={roles.action}
					strokeWidth={STROKE}
					strokeDasharray="2 3"
					className="hidden motion-reduce:inline"
				/>
			)}
		</svg>
	);
};
