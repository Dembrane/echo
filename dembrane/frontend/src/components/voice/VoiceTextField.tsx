import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Box, Button, Group, Stack, Textarea } from "@mantine/core";
import { StopIcon } from "@phosphor-icons/react";
import type React from "react";
import { roles } from "@/colors";
import { CharsRemainingIndicator } from "@/components/common/CharsRemainingIndicator";
import type { UseVoiceTranscriptionResult } from "./useVoiceTranscription";
import { VoiceInputButton } from "./VoiceInputButton";
import { VoiceInputError } from "./VoiceInputError";
import { VoiceRecordingBar } from "./VoiceRecordingBar";

/** A plain text box that takes a voice note as well as typing. The host owns the text
 * and the voice hook, so it decides what a transcript does to the draft and when its
 * own submit waits; this only draws the field the same way everywhere. */
export const VoiceTextField = ({
	ariaLabel,
	maxLength,
	maxRows = 20,
	minRows = 6,
	onChange,
	onPaste,
	placeholder,
	testIdPrefix,
	value,
	voice,
}: {
	ariaLabel: string;
	maxLength: number;
	/** Past this the field scrolls instead of the page around it. */
	maxRows?: number;
	minRows?: number;
	onChange: (value: string) => void;
	onPaste?: (event: React.ClipboardEvent) => void;
	placeholder: string;
	/** Prefixes the ids `-message`, `-voice-record` and `-voice-stop`. */
	testIdPrefix: string;
	value: string;
	voice: UseVoiceTranscriptionResult;
}) => {
	const isVoiceActive = voice.status !== "idle";
	const atLimit = value.length >= maxLength;
	// Named so the tooltip keeps the message id it is already translated under.
	const MAX_MESSAGE_CHARS = maxLength;

	return (
		<Stack>
			{voice.errorKind && (
				<VoiceInputError
					kind={voice.errorKind}
					onDismiss={voice.dismissError}
				/>
			)}
			{/* One input frame: the text scrolls, the footer with mic controls does
			    not. A field, so rules at the sides, blue while focused. */}
			<Box
				className="border-x border-y-0 border-solid border-[color:var(--app-control-rule)] focus-within:border-[var(--app-action)]"
				px="sm"
				pt="xs"
				pb="xs"
				style={{ backgroundColor: roles.surface }}
			>
				<Textarea
					value={value}
					onChange={(event) => onChange(event.currentTarget.value)}
					onPaste={onPaste}
					readOnly={isVoiceActive}
					aria-label={ariaLabel}
					placeholder={placeholder}
					maxLength={maxLength}
					minRows={minRows}
					maxRows={maxRows}
					autosize
					resize="none"
					variant="unstyled"
					styles={{ input: { backgroundColor: "transparent", padding: 0 } }}
					data-testid={`${testIdPrefix}-message`}
				/>
				<Group justify="flex-end" align="center" gap="sm" wrap="nowrap" mt="xs">
					{isVoiceActive && (
						<Box className="flex-1">
							<VoiceRecordingBar
								elapsedMs={voice.elapsedMs}
								isTranscribing={voice.status === "transcribing"}
								levels={voice.levels}
							/>
						</Box>
					)}
					{voice.status === "recording" ? (
						<Button
							aria-label={t`Stop recording and turn it into text`}
							onClick={voice.stop}
							leftSection={<StopIcon size={20} />}
							color="red"
							size="compact-sm"
							type="button"
							data-testid={`${testIdPrefix}-voice-stop`}
						>
							<Trans>Stop</Trans>
						</Button>
					) : voice.status === "transcribing" ? null : (
						<VoiceInputButton
							ariaLabel={t`Record a voice message`}
							disabled={voice.isStarting || atLimit}
							onClick={voice.start}
							testId={`${testIdPrefix}-voice-record`}
							tooltip={
								atLimit ? t`Up to ${MAX_MESSAGE_CHARS} characters` : undefined
							}
						/>
					)}
				</Group>
			</Box>
			<CharsRemainingIndicator value={value} max={maxLength} />
		</Stack>
	);
};
