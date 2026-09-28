import { Group, RingProgress, Text } from "@mantine/core";

const DEFAULT_NUMBER_THRESHOLD_RATIO = 0.5;
const DEFAULT_NUMBER_THRESHOLD_CAP = 50;

type CharsRemainingIndicatorProps = {
	value: string;
	max: number;
	/** Ratio of `max` below which the indicator appears. @default 0.5 */
	numberThresholdRatio?: number;
	/** Upper bound (in chars) on the visibility threshold. @default 50 */
	numberThresholdCap?: number;
	/** @default "right" */
	align?: "left" | "center" | "right";
};

const ALIGN_TO_JUSTIFY = {
	center: "center",
	left: "flex-start",
	right: "flex-end",
} as const;

/**
 * Custom remaining-characters indicator. Renders nothing until the
 * field is close to its limit, then shows a ring with the remaining count
 * inside — colored with the brand caution tone, switching to the brand
 * danger tone at the cap.
 */
export const CharsRemainingIndicator = ({
	value,
	max,
	numberThresholdRatio = DEFAULT_NUMBER_THRESHOLD_RATIO,
	numberThresholdCap = DEFAULT_NUMBER_THRESHOLD_CAP,
	align = "right",
}: CharsRemainingIndicatorProps) => {
	if (max <= 0) return null;
	const remaining = Math.max(0, max - value.length);
	if (remaining > Math.min(numberThresholdCap, max * numberThresholdRatio)) {
		return null;
	}
	const filled = Math.min(100, (value.length / max) * 100);
	const atLimit = remaining === 0;
	const ringColor = atLimit ? "salmon" : "peach";
	const textColor = atLimit ? "salmon" : "dimmed";
	return (
		<Group justify={ALIGN_TO_JUSTIFY[align]}>
			<RingProgress
				size={32}
				thickness={2}
				sections={[{ color: ringColor, value: filled }]}
				label={
					<Text size="xs" ta="center" c={textColor}>
						{remaining}
					</Text>
				}
			/>
		</Group>
	);
};
