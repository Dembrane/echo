import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Box,
	Button,
	Checkbox,
	Group,
	Paper,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useEffect, useState } from "react";
import {
	type PopcornDetail,
	type PopcornVoice,
	usePopcornSettingsMutation,
} from "@/components/popcorn/hooks";
import { PricingTextInput } from "@/components/pricing/PricingTextInput";
import { testId } from "@/lib/testUtils";

// One control size for every field on these forms, including the voice
// composer, so nothing looks like it belongs to another screen.
export const FIELD_SIZE = "sm";

export const EMPTY_VOICE: PopcornVoice = { note: "", presets: [] };

// Same shape as the booking form's use-case step: a few checkable ways to
// steer the phrases, each with one line of explanation, and "something else"
// revealing the typed-or-spoken free text. Nothing chosen means the prompt
// exactly as written.
export function VoiceFields({
	projectId,
	voice,
	onChange,
}: {
	projectId: string;
	voice: PopcornVoice;
	onChange: (voice: PopcornVoice) => void;
}) {
	const [otherOpen, setOtherOpen] = useState(!!voice.note);
	// The default is the prompt as written. It is on whenever nothing else is,
	// and choosing it clears everything else, so it reads as one of the choices
	// rather than as the absence of one.
	const isDefault = !voice.note && !otherOpen;
	return (
		<Stack gap="sm">
			<Text fw={500}>
				<Trans>How should the phrases sound?</Trans>
			</Text>
			<Checkbox
				checked={isDefault}
				onChange={(event) => {
					if (!event.currentTarget.checked) return;
					setOtherOpen(false);
					onChange({ note: "", presets: [] });
				}}
				label={t`dembrane default`}
				description={t`The room's own words, the ideas that moved the conversation.`}
				size={FIELD_SIZE}
				{...testId("popcorn-voice-default")}
			/>
			<Box>
				<Checkbox
					checked={otherOpen}
					onChange={(event) => {
						const open = event.currentTarget.checked;
						setOtherOpen(open);
						if (!open) onChange({ ...voice, note: "" });
					}}
					label={t`Something else`}
					description={t`Say it in your own words. Type, or press record and talk.`}
					size={FIELD_SIZE}
					{...testId("popcorn-voice-other")}
				/>
				{otherOpen ? (
					<Box mt="sm" pl="xl">
						<PricingTextInput
							minRows={1}
							onChange={(note) => onChange({ ...voice, note })}
							placeholder={t`For example: keep the members' own words, skip anything about named staff.`}
							projectId={projectId}
							questionKey="popcorn_voice"
							testIdPrefix="popcorn-voice"
							value={voice.note}
						/>
					</Box>
				) : null}
			</Box>
		</Stack>
	);
}

// The session's title and voice, saved together. A changed voice re-reads
// every conversation on the next read, so the section says so.
export function PopcornVoiceSection({
	projectId,
	popcorn,
}: {
	projectId: string;
	popcorn: PopcornDetail;
}) {
	const settings = usePopcornSettingsMutation(projectId, popcorn.id);
	const [title, setTitle] = useState(popcorn.settings.title);
	const [voice, setVoice] = useState<PopcornVoice>(
		popcorn.settings.voice ?? EMPTY_VOICE,
	);
	const [titleError, setTitleError] = useState<string | null>(null);

	useEffect(() => {
		setTitle(popcorn.settings.title);
		setVoice(popcorn.settings.voice ?? EMPTY_VOICE);
	}, [popcorn.settings]);

	const current = popcorn.settings.voice ?? EMPTY_VOICE;
	const voiceChanged =
		voice.note.trim() !== current.note ||
		voice.presets.join(",") !== current.presets.join(",");
	const titleChanged = title.trim() !== popcorn.settings.title;

	return (
		<Paper
			withBorder
			className="rounded-md"
			p="lg"
			{...testId("popcorn-voice")}
		>
			<Stack gap="md">
				<Title order={4}>
					<Trans>Voice</Trans>
				</Title>
				<TextInput
					label={t`Title`}
					description={t`Shown at the top of the screen.`}
					size={FIELD_SIZE}
					value={title}
					error={titleError}
					maxLength={160}
					onChange={(event) => {
						setTitle(event.currentTarget.value);
						setTitleError(null);
					}}
					{...testId("popcorn-title-edit-input")}
				/>
				<VoiceFields projectId={projectId} voice={voice} onChange={setVoice} />
				{voiceChanged ? (
					<Text size="sm">
						<Trans>Changing the voice re-reads every conversation.</Trans>
					</Text>
				) : null}
				<Group justify="flex-end">
					<Button
						size={FIELD_SIZE}
						disabled={!voiceChanged && !titleChanged}
						loading={settings.isPending}
						onClick={() => {
							if (!title.trim()) {
								setTitleError(t`Give the session a title`);
								return;
							}
							settings.mutate({
								title: title.trim(),
								voice: { note: voice.note.trim(), presets: voice.presets },
							});
						}}
						{...testId("popcorn-title-save")}
					>
						<Trans>Save</Trans>
					</Button>
				</Group>
			</Stack>
		</Paper>
	);
}
