import { useReducedMotion } from "@mantine/hooks";
import { cn } from "@/lib/utils";

type CountdownProgressBarProps = {
	durationMs: number;
	remainingMs: number;
	isActive: boolean;
	className?: string;
};

/** A bar that shrinks from full to empty over the walk interval. */
export const CountdownProgressBar = ({
	durationMs,
	remainingMs,
	isActive,
	className,
}: CountdownProgressBarProps) => {
	const reduceMotion = useReducedMotion();

	let widthPercent = 0;
	if (isActive && durationMs > 0) {
		widthPercent = Math.min(1, Math.max(0, remainingMs / durationMs)) * 100;
	}

	return (
		<div
			className={cn("h-full", className)}
			style={{
				transition: !isActive || reduceMotion ? "none" : "width 0.3s linear",
				width: `${widthPercent}%`,
				willChange: "width",
			}}
			data-idle={!isActive}
			aria-hidden="true"
		/>
	);
};
