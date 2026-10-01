import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Alert, Button, Group, Text } from "@mantine/core";
import { toast } from "@/components/common/Toaster";
import { testId } from "@/lib/testUtils";
import { checkPermissionError } from "@/lib/utils";
import type { VoiceErrorKind } from "./voiceInput";

/** Where a host goes when the browser has blocked the microphone. Same guide
 * the portal points participants at. */
const MICROPHONE_TROUBLESHOOTING_URL =
	"https://dembrane.notion.site/Troubleshooting-Microphone-Permissions-All-Languages-bd340257647742cd9cd960f94c4223bb?pvs=74";

/** Denials and empty recordings are things a host can fix in a second, so they
 * read as amber. Red is kept for a call that actually failed. */
const RECOVERABLE_KINDS = new Set<VoiceErrorKind>([
	"permission",
	"unsupported",
	"device",
	"too_short",
	"empty",
]);

const messageFor = (kind: VoiceErrorKind): string => {
	switch (kind) {
		case "permission":
			return t`Your browser is blocking the microphone. Allow access, then try again.`;
		case "unsupported":
			return t`This browser cannot record audio. Chrome, Edge and Safari can.`;
		case "device":
			return t`No microphone was available. Check that one is connected and not in use elsewhere.`;
		case "too_short":
			return t`That was too short to transcribe. Hold the recording a little longer.`;
		case "empty":
			return t`There was no speech in that recording.`;
		case "too_large":
			return t`That recording is too long to send. Record a shorter note.`;
		case "not_allowed":
			return t`You do not have permission to transcribe in this project.`;
		case "not_found":
			return t`This project could not be reached.`;
		case "transcription_failed":
			return t`The transcription did not finish. Try again.`;
		case "network":
			return t`The transcript did not come back. Check your connection and try again.`;
		default:
			return t`Something went wrong while transcribing. Try again.`;
	}
};

export const VoiceInputError = ({
	kind,
	onDismiss,
}: {
	kind: VoiceErrorKind;
	onDismiss: () => void;
}) => {
	const handleCheckAccess = async () => {
		const state = await checkPermissionError();
		if (state === "granted" || state === "prompt") {
			// No reload: the host may have a half-typed message in the composer.
			onDismiss();
			return;
		}
		toast.error(
			t`The microphone is still blocked. Change it in your browser settings, then check again.`,
		);
	};

	return (
		<Alert
			className="mb-2"
			color={RECOVERABLE_KINDS.has(kind) ? "yellow" : "red"}
			onClose={onDismiss}
			withCloseButton
			{...testId("chat-voice-error")}
		>
			<Text size="sm">{messageFor(kind)}</Text>
			{kind === "permission" && (
				<Group gap="xs" mt="xs">
					<Button
						component="a"
						href={MICROPHONE_TROUBLESHOOTING_URL}
						rel="noreferrer"
						size="compact-sm"
						target="_blank"
						variant="subtle"
						{...testId("chat-voice-troubleshooting-link")}
					>
						<Trans>Open the troubleshooting guide</Trans>
					</Button>
					<Button
						onClick={() => void handleCheckAccess()}
						size="compact-sm"
						type="button"
						variant="subtle"
						{...testId("chat-voice-recheck-permission")}
					>
						<Trans>Check microphone access</Trans>
					</Button>
				</Group>
			)}
		</Alert>
	);
};
