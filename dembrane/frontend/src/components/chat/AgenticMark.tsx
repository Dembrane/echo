import { Box } from "@mantine/core";
import { IconSparkles } from "@tabler/icons-react";
import { MODE_COLORS } from "./ChatModeSelector";

/** Agentic Chat's one splash of brand green: a Spring Green disc with a dark
 * sparkle. Green as a thin line or text on parchment all but vanishes; as a
 * fill behind a dark glyph it reads, and stays the true brand hex. */
export const AgenticMark = ({ size = 20 }: { size?: number }) => (
	<Box
		data-testid="agentic-mark"
		aria-hidden="true"
		className="inline-flex shrink-0 items-center justify-center rounded-full"
		style={{
			backgroundColor: MODE_COLORS.agentic.primary,
			height: size,
			width: size,
		}}
	>
		<IconSparkles
			size={Math.round(size * 0.6)}
			stroke={2}
			color="var(--app-text)"
		/>
	</Box>
);
