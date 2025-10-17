import { Progress } from "@mantine/core";
import { useEffect, useState } from "react";

interface ExponentialProgressProps {
	isLoading: boolean;
	/**
	 * Expected duration in seconds
	 * @default 5
	 */
	expectedDuration?: number;
	size?: string | number;
	radius?: string | number;
	/**
	 * Color when progress is below threshold
	 * @default "blue"
	 */
	primaryColor?: string;
	/**
	 * Color when progress is above threshold
	 * @default "yellow"
	 */
	warningColor?: string;
	/**
	 * Threshold percentage to switch colors
	 * @default 90
	 */
	warningThreshold?: number;
}

export const ExponentialProgress = ({
	isLoading,
	expectedDuration = 5,
	size = "md",
	radius = "md",
	primaryColor = "blue",
	warningColor = "yellow",
	warningThreshold = 90,
}: ExponentialProgressProps) => {
	const [progress, setProgress] = useState(0);

	useEffect(() => {
		if (!isLoading) {
			setProgress(0);
			return;
		}

		const interval = setInterval(() => {
			setProgress((prev) => {
				const remaining = 100 - prev;
				// Scale the increment based on expected duration
				// Slower progression for longer durations
				const scaleFactor = 0.1 * (5 / expectedDuration);
				const increment = remaining * scaleFactor;
				return Math.min(prev + increment, 97.5);
			});
		}, 100);

		return () => clearInterval(interval);
	}, [isLoading, expectedDuration]);

	return (
		<Progress
			value={progress}
			animated
			size={size}
			radius={radius}
			color={progress > warningThreshold ? warningColor : primaryColor}
		/>
	);
};
