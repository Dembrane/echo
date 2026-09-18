import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Group,
	Paper,
	Stack,
	Switch,
	Text,
	Textarea,
	TextInput,
	Title,
} from "@mantine/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SaveStatus } from "@/components/form/SaveStatus";
import {
	type PopcornData,
	type PopcornDetail,
	type PopcornDisclosure,
	type PopcornIntro,
	type PopcornNotice,
	usePopcornSettingsMutation,
} from "@/components/popcorn/hooks";
import { FIELD_SIZE } from "@/components/popcorn/PopcornVoiceSection";
import { useSettingsFlush } from "@/components/popcorn/SettingsSaveContext";
import { useAutoSave } from "@/hooks/useAutoSave";
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

const openingFrom = (popcorn: PopcornDetail): Opening => ({
	data: popcorn.settings.data ?? EMPTY.data,
	disclosure: popcorn.settings.disclosure ?? EMPTY.disclosure,
	intro: popcorn.settings.intro ?? EMPTY.intro,
	notice: popcorn.settings.notice ?? EMPTY.notice,
});

// What the room reads before the countdown, and the frame above every tab.
// A synthetic demo's disclosure and frame come with the demo and are not the
// host's to change. Present embeds one section at a time and supplies the title.
export function PopcornOpeningSettings({
	projectId,
	popcorn,
	section,
	embedded = section !== undefined,
}: {
	projectId: string;
	popcorn: PopcornDetail;
	section?: "intro" | "data";
	embedded?: boolean;
}) {
	const serverKey = JSON.stringify(openingFrom(popcorn));
	const serverOpening = useMemo<Opening>(
		() => JSON.parse(serverKey),
		[serverKey],
	);
	const formIdentity = `${projectId}:${popcorn.id}:${section ?? "all"}`;
	const [opening, setOpening] = useState<Opening>(serverOpening);
	const currentRef = useRef(opening);
	const dirtyRef = useRef(false);
	const identityRef = useRef(formIdentity);
	const mutation = usePopcornSettingsMutation(projectId, popcorn.id);
	const synthetic = popcorn.synthetic === true;
	const onSave = useCallback(
		async (next: Opening) => {
			const savedDraft = JSON.stringify(next);
			await mutation.mutateAsync(
				section === "intro"
					? synthetic
						? { intro: next.intro }
						: { intro: next.intro, notice: next.notice }
					: section === "data"
						? synthetic
							? { data: next.data }
							: { data: next.data, disclosure: next.disclosure }
						: synthetic
							? { data: next.data, intro: next.intro }
							: next,
			);
			// A response for an older draft must not make a newer keystroke clean.
			if (JSON.stringify(currentRef.current) === savedDraft) {
				dirtyRef.current = false;
			}
		},
		[mutation.mutateAsync, section, synthetic],
	);
	const {
		dispatchAutoSave,
		isError,
		isPendingSave,
		isSaving,
		lastSavedAt,
		triggerManualSave,
	} = useAutoSave({
		initialLastSavedAt: popcorn.updated_at ?? undefined,
		onSave,
	});
	useSettingsFlush(async () => {
		if (!dirtyRef.current && !isPendingSave) return;
		const saved = await triggerManualSave(currentRef.current);
		if (!saved) throw new Error("Could not save opening settings");
	}, isPendingSave || isSaving);

	// Refetches can arrive while an older autosave is in flight. Adopt server
	// changes only when this form has no newer local draft to protect.
	useEffect(() => {
		if (identityRef.current !== formIdentity) {
			identityRef.current = formIdentity;
			currentRef.current = serverOpening;
			dirtyRef.current = false;
			setOpening(serverOpening);
			return;
		}
		if (!dirtyRef.current && JSON.stringify(currentRef.current) !== serverKey) {
			currentRef.current = serverOpening;
			setOpening(serverOpening);
		}
	}, [formIdentity, serverKey, serverOpening]);

	const changeOpening = (next: Opening) => {
		currentRef.current = next;
		dirtyRef.current = true;
		setOpening(next);
		dispatchAutoSave(next);
	};
	const { intro, disclosure, notice, data } = opening;

	const content = (
		<Stack gap="md" {...(embedded ? testId("popcorn-opening") : {})}>
			<Group justify={embedded ? "flex-end" : "space-between"}>
				{!embedded && (
					<Title order={4}>
						{section === "data"
							? t`Data policy and disclosure`
							: t`Opening and frame`}
					</Title>
				)}
				<SaveStatus
					formErrors={{}}
					isError={isError}
					isPendingSave={isPendingSave}
					isSaving={isSaving}
					savedAt={lastSavedAt}
				/>
			</Group>
			{section !== "data" && (
				<>
					<Switch
						size={FIELD_SIZE}
						label={t`Show introduction`}
						description={t`A title and subtitle before the countdown.`}
						checked={intro.enabled}
						onChange={(event) =>
							changeOpening({
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
									changeOpening({
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
									changeOpening({
										...opening,
										intro: { ...intro, subtitle: event.currentTarget.value },
									})
								}
							/>
						</>
					)}
				</>
			)}
			{synthetic ? (
				<Text size="sm" c="dimmed" {...testId("popcorn-synthetic-note")}>
					<Trans>
						This is a synthetic demo. Its disclosure and frame are set with the
						demo and always show.
					</Trans>
				</Text>
			) : (
				<>
					{section !== "intro" && (
						<>
							<Switch
								size={FIELD_SIZE}
								label={t`Show a disclosure`}
								description={t`A screen before the countdown that says what the room is looking at.`}
								checked={disclosure.enabled}
								onChange={(event) =>
									changeOpening({
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
											changeOpening({
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
											changeOpening({
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
											changeOpening({
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
						</>
					)}
					{section !== "data" && (
						<>
							<Switch
								size={FIELD_SIZE}
								label={t`Show a frame`}
								description={t`A blue bar across the top of every tab, with your text and a link back to the opening.`}
								checked={notice.enabled}
								onChange={(event) =>
									changeOpening({
										...opening,
										notice: {
											...notice,
											enabled: event.currentTarget.checked,
										},
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
										changeOpening({
											...opening,
											notice: { ...notice, text: event.currentTarget.value },
										})
									}
								/>
							)}
						</>
					)}
				</>
			)}
			{section !== "intro" && (
				<Switch
					size={FIELD_SIZE}
					label={t`Show what happens to the data`}
					description={t`A screen that explains, step by step, what happens to the recordings. Its words follow this project's anonymization and legal basis.`}
					checked={data.enabled}
					onChange={(event) =>
						changeOpening({
							...opening,
							data: { enabled: event.currentTarget.checked },
						})
					}
					{...testId("popcorn-data-toggle")}
				/>
			)}
			{!synthetic &&
				((disclosure.enabled && !disclosure.text.trim()) ||
					(notice.enabled && !notice.text.trim())) && (
					<Text size="sm" c="dimmed">
						<Trans>A switch without words shows nothing on the screen.</Trans>
					</Text>
				)}
		</Stack>
	);

	if (embedded) return content;
	return (
		<Paper
			withBorder
			className="rounded-md"
			p="lg"
			{...testId("popcorn-opening")}
		>
			{content}
		</Paper>
	);
}
