import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Button,
	Paper,
	Stack,
	Switch,
	Text,
	Textarea,
	TextInput,
	Title,
} from "@mantine/core";
import { useEffect, useState } from "react";
import {
	type PopcornData,
	type PopcornDetail,
	type PopcornDisclosure,
	type PopcornIntro,
	type PopcornNotice,
	usePopcornSettingsMutation,
} from "@/components/popcorn/hooks";
import { FIELD_SIZE } from "@/components/popcorn/PopcornVoiceSection";
import { testId } from "@/lib/testUtils";

type Opening = {
	intro: PopcornIntro;
	disclosure: PopcornDisclosure;
	notice: PopcornNotice;
	data: PopcornData;
};

const EMPTY: Opening = {
	data: { enabled: false },
	disclosure: {
		enabled: false,
		invitation_text: "",
		invitation_title: "",
		text: "",
	},
	intro: { enabled: false, subtitle: "", title: "" },
	notice: { enabled: false, text: "" },
};

// What the room reads before the countdown, and the frame above every tab.
// Words need a Save, so the switches wait for it too. A synthetic demo's
// disclosure and frame come with the demo and are not the host's to change.
export function PopcornOpeningSettings({
	projectId,
	popcorn,
}: {
	projectId: string;
	popcorn: PopcornDetail;
}) {
	const savedKey = JSON.stringify({
		data: popcorn.settings.data ?? EMPTY.data,
		disclosure: popcorn.settings.disclosure ?? EMPTY.disclosure,
		intro: popcorn.settings.intro ?? EMPTY.intro,
		notice: popcorn.settings.notice ?? EMPTY.notice,
	});
	const [opening, setOpening] = useState<Opening>(() => JSON.parse(savedKey));
	// A refetch resets the form only when the saved words changed.
	useEffect(() => setOpening(JSON.parse(savedKey)), [savedKey]);
	const mutation = usePopcornSettingsMutation(projectId, popcorn.id);
	const synthetic = popcorn.synthetic === true;
	const { intro, disclosure, notice, data } = opening;

	return (
		<Paper
			withBorder
			className="rounded-md"
			p="lg"
			{...testId("popcorn-opening")}
		>
			<Stack gap="md">
				<Title order={4}>
					<Trans>Opening and frame</Trans>
				</Title>
				<Switch
					size={FIELD_SIZE}
					label={t`Show introduction`}
					description={t`A title and subtitle before the countdown.`}
					checked={intro.enabled}
					onChange={(event) =>
						setOpening({
							...opening,
							intro: { ...intro, enabled: event.currentTarget.checked },
						})
					}
					{...testId("popcorn-intro-toggle")}
				/>
				{intro.enabled && (
					<>
						<TextInput
							size={FIELD_SIZE}
							label={t`Introduction title`}
							maxLength={160}
							value={intro.title}
							onChange={(event) =>
								setOpening({
									...opening,
									intro: { ...intro, title: event.currentTarget.value },
								})
							}
						/>
						<Textarea
							size={FIELD_SIZE}
							label={t`Introduction subtitle`}
							maxLength={600}
							autosize
							minRows={2}
							value={intro.subtitle}
							onChange={(event) =>
								setOpening({
									...opening,
									intro: { ...intro, subtitle: event.currentTarget.value },
								})
							}
						/>
					</>
				)}
				{synthetic ? (
					<Text size="sm" c="dimmed" {...testId("popcorn-synthetic-note")}>
						<Trans>
							This is a synthetic demo. Its disclosure and frame are set with
							the demo and always show.
						</Trans>
					</Text>
				) : (
					<>
						<Switch
							size={FIELD_SIZE}
							label={t`Show a disclosure`}
							description={t`A screen before the countdown that says what the room is looking at.`}
							checked={disclosure.enabled}
							onChange={(event) =>
								setOpening({
									...opening,
									disclosure: {
										...disclosure,
										enabled: event.currentTarget.checked,
									},
								})
							}
							{...testId("popcorn-disclosure-toggle")}
						/>
						{disclosure.enabled && (
							<>
								<Textarea
									size={FIELD_SIZE}
									label={t`Disclosure`}
									description={t`Each line becomes a paragraph.`}
									maxLength={600}
									autosize
									minRows={2}
									value={disclosure.text}
									onChange={(event) =>
										setOpening({
											...opening,
											disclosure: {
												...disclosure,
												text: event.currentTarget.value,
											},
										})
									}
								/>
								<TextInput
									size={FIELD_SIZE}
									label={t`Follow-up title`}
									description={t`An optional second screen after the disclosure.`}
									maxLength={160}
									value={disclosure.invitation_title}
									onChange={(event) =>
										setOpening({
											...opening,
											disclosure: {
												...disclosure,
												invitation_title: event.currentTarget.value,
											},
										})
									}
								/>
								<Textarea
									size={FIELD_SIZE}
									label={t`Follow-up text`}
									description={t`With several lines, the first reads as a subtitle.`}
									maxLength={600}
									autosize
									minRows={2}
									value={disclosure.invitation_text}
									onChange={(event) =>
										setOpening({
											...opening,
											disclosure: {
												...disclosure,
												invitation_text: event.currentTarget.value,
											},
										})
									}
								/>
							</>
						)}
						<Switch
							size={FIELD_SIZE}
							label={t`Show a frame`}
							description={t`A blue bar across the top of every tab, with your text and a link back to the opening.`}
							checked={notice.enabled}
							onChange={(event) =>
								setOpening({
									...opening,
									notice: { ...notice, enabled: event.currentTarget.checked },
								})
							}
							{...testId("popcorn-notice-toggle")}
						/>
						{notice.enabled && (
							<TextInput
								size={FIELD_SIZE}
								label={t`Frame text`}
								maxLength={160}
								value={notice.text}
								onChange={(event) =>
									setOpening({
										...opening,
										notice: { ...notice, text: event.currentTarget.value },
									})
								}
							/>
						)}
					</>
				)}
				<Switch
					size={FIELD_SIZE}
					label={t`Show what happens to the data`}
					description={t`A screen that explains, step by step, what happens to the recordings. Its words follow this project's anonymization and legal basis.`}
					checked={data.enabled}
					onChange={(event) =>
						setOpening({
							...opening,
							data: { enabled: event.currentTarget.checked },
						})
					}
					{...testId("popcorn-data-toggle")}
				/>
				{!synthetic &&
					((disclosure.enabled && !disclosure.text.trim()) ||
						(notice.enabled && !notice.text.trim())) && (
						<Text size="sm" c="dimmed">
							<Trans>A switch without words shows nothing on the screen.</Trans>
						</Text>
					)}
				<Button
					size={FIELD_SIZE}
					loading={mutation.isPending}
					disabled={JSON.stringify(opening) === savedKey}
					onClick={() => mutation.mutate(synthetic ? { data, intro } : opening)}
					{...testId("popcorn-opening-save")}
				>
					<Trans>Save opening</Trans>
				</Button>
			</Stack>
		</Paper>
	);
}
