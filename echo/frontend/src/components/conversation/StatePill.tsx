import { t } from "@lingui/core/macro";
import { Badge } from "@mantine/core";

import type {
	MonitorConversation,
	ParticipantState,
} from "@/hooks/useConversationMonitor";

type StateMeta = {
	color: string;
	label: string;
	pulse?: boolean;
	variant?: "light" | "filled";
};

const stateMeta = (state: ParticipantState): StateMeta => {
	switch (state) {
		case "recording":
			return { color: "red", label: t`Recording`, pulse: true };
		case "paused":
			return { color: "yellow", label: t`Paused` };
		case "verifying":
			return { color: "primary", label: t`Verifying` };
		case "refining":
			return { color: "grape", label: t`Exploring` };
		case "text":
			return { color: "primary", label: t`Typing` };
		case "finishing":
			return { color: "primary", label: t`Finishing` };
		case "finished":
			return { color: "primary", label: t`Finished` };
		case "waiting":
			return { color: "gray", label: t`Waiting` };
		case "initiated":
			return { color: "gray", label: t`Just started` };
		// Solid fill so offline stands out (mauve's light tint is near-white).
		case "offline":
			return { color: "mauve", label: t`Offline`, variant: "filled" };
		case "left":
			return { color: "gray", label: t`Left` };
		case "backgrounded":
			return { color: "gray", label: t`Away` };
		default:
			return { color: "gray", label: t`Idle` };
	}
};

// Theme color name for a state, shared with the timer dot.
export const stateColor = (state: ParticipantState): string =>
	stateMeta(state).color;

export const isProblemState = (conversation: MonitorConversation): boolean =>
	conversation.recording_health === "stalled" ||
	conversation.has_error ||
	conversation.state === "offline" ||
	conversation.transcription_status === "failing";

// Graphite label. On a light pill the dot keeps its tint (currentColor); on a
// filled pill the dot is graphite too so it stays visible on the fill.
const LIGHT_STYLES = { label: { color: "var(--app-text)" } };
const FILLED_STYLES = {
	label: { color: "var(--app-text)" },
	section: { color: "var(--app-text)" },
};

export const StatePill = ({ state }: { state: ParticipantState }) => {
	const meta = stateMeta(state);
	const filled = meta.variant === "filled";

	return (
		<Badge
			size="sm"
			color={meta.color}
			variant={meta.variant ?? "light"}
			styles={filled ? FILLED_STYLES : LIGHT_STYLES}
			leftSection={
				<span
					aria-hidden
					className={`inline-block h-1.5 w-1.5 rounded-full bg-current ${
						meta.pulse ? "animate-pulse" : ""
					}`}
				/>
			}
		>
			{meta.label}
		</Badge>
	);
};
