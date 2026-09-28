import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Box,
	Checkbox,
	Group,
	Paper,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useState } from "react";
import { SaveStatus } from "@/components/form/SaveStatus";
import {
	type PopcornDetail,
	type PopcornVoice,
	usePopcornSettingsMutation,
} from "@/components/popcorn/hooks";
import { useSettingsDraft } from "@/components/popcorn/useSettingsDraft";
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

type VoiceSettingsDraft = {
	title: string;
	voice: PopcornVoice;
};

const voiceSettingsFrom = (popcorn: PopcornDetail): VoiceSettingsDraft => ({
	title: popcorn.settings.title,
	voice: popcorn.settings.voice ?? EMPTY_VOICE,
});

// Legacy Popcorn settings edit the session title and voice together. Analysis
// embeds only voice because presentation naming belongs to Present.
export function PopcornVoiceSection({
	projectId,
	popcorn,
	showTitle = true,
}: {
	projectId: string;
	popcorn: PopcornDetail;
	showTitle?: boolean;
}) {
	const settings = usePopcornSettingsMutation(projectId, popcorn.id);
	const { changeDraft, draft, isError, isPendingSave, isSaving, lastSavedAt } =
		useSettingsDraft<VoiceSettingsDraft>({
			flushErrorMessage: "Could not save voice settings",
			identity: `${projectId}:${popcorn.id}:${showTitle ? "title-and-voice" : "voice"}`,
			initialLastSavedAt: popcorn.updated_at ?? undefined,
			// A presentation without a title is refused rather than saved, so the
			// draft stays dirty and SaveStatus shows the error.
			save: async (next) => {
				if (showTitle && !next.title.trim())
					throw new Error("A presentation title is required.");
				await settings.mutateAsync({
					...(showTitle ? { title: next.title.trim() } : {}),
					voice: {
						note: next.voice.note.trim(),
						presets: next.voice.presets,
					},
				});
			},
			serverValue: voiceSettingsFrom(popcorn),
		});

	return (
		<Paper
			withBorder
			className="rounded-md"
			p="lg"
			{...testId("popcorn-voice")}
		>
			<Stack gap="md">
				<Group justify="space-between">
					<Title order={4}>
						<Trans>Voice</Trans>
					</Title>
					<SaveStatus
						formErrors={{}}
						isError={isError}
						isPendingSave={isPendingSave}
						isSaving={isSaving}
						savedAt={lastSavedAt}
					/>
				</Group>
				{showTitle && (
					<TextInput
						label={t`Title`}
						description={t`Shown at the top of the screen.`}
						size={FIELD_SIZE}
						value={draft.title}
						error={
							!draft.title.trim() ? t`Give the session a title` : undefined
						}
						maxLength={160}
						onChange={(event) =>
							changeDraft({ ...draft, title: event.currentTarget.value })
						}
						{...testId("popcorn-title-edit-input")}
					/>
				)}
				<VoiceFields
					projectId={projectId}
					voice={draft.voice}
					onChange={(voice) => changeDraft({ ...draft, voice })}
				/>
				<Text size="sm">
					<Trans>
						Voice changes apply the next time you prepare or update Popcorn
						results.
					</Trans>
				</Text>
			</Stack>
		</Paper>
	);
}
