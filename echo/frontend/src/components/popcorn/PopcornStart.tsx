import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Button,
	Group,
	Paper,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useEffect, useState } from "react";
import { PageContainer } from "@/components/layout/PageContainer";
import {
	type PopcornReadiness,
	type PopcornVoice,
	useCreatePopcornMutation,
} from "@/components/popcorn/hooks";
import {
	EMPTY_VOICE,
	FIELD_SIZE,
	VoiceFields,
} from "@/components/popcorn/PopcornVoiceSection";
import { testId } from "@/lib/testUtils";

// Before a session exists: what a first read would find, the title, the
// voice, and Run. Run reads once; live is a choice made later.
export function PopcornStart({
	projectId,
	projectName,
	readiness,
}: {
	projectId: string;
	projectName: string;
	readiness?: PopcornReadiness;
}) {
	const [title, setTitle] = useState(projectName);
	const [titleError, setTitleError] = useState<string | null>(null);
	const [voice, setVoice] = useState<PopcornVoice>(EMPTY_VOICE);
	const create = useCreatePopcornMutation(projectId);

	useEffect(() => {
		setTitle((current) => current || projectName);
	}, [projectName]);

	const conversations = readiness?.conversations ?? 0;
	const minutes = Math.max(1, Math.round((readiness?.words ?? 0) / 150));
	const ready = conversations > 0;

	return (
		<PageContainer width="md">
			<Stack gap="lg">
				<Stack gap="xs">
					<Title order={2}>
						<Trans>Popcorn</Trans>
					</Title>
					<Text>
						<Trans>
							Live slides for the room, made from this project's conversations.
						</Trans>
					</Text>
					<Text size="sm" {...testId("popcorn-readiness")}>
						{readiness === undefined
							? t`Looking at the conversations…`
							: ready
								? t`${conversations} conversations with a transcript, about ${minutes} minutes of talk. Ready.`
								: t`No transcripts yet. You can run popcorn now; the screen fills as conversations land.`}
					</Text>
				</Stack>
				<Paper withBorder className="rounded-md" p="lg">
					<Stack gap="lg">
						<TextInput
							label={t`Session title`}
							description={t`Shown at the top of the screen. Change it any time.`}
							size={FIELD_SIZE}
							value={title}
							error={titleError}
							maxLength={160}
							onChange={(event) => {
								setTitle(event.currentTarget.value);
								setTitleError(null);
							}}
							{...testId("popcorn-title-input")}
						/>
						<VoiceFields
							projectId={projectId}
							voice={voice}
							onChange={setVoice}
						/>
						<Group justify="flex-end">
							<Button
								size={FIELD_SIZE}
								loading={create.isPending}
								onClick={() => {
									if (!title.trim()) {
										setTitleError(t`Give the session a title`);
										return;
									}
									create.mutate({
										title: title.trim(),
										voice:
											voice.presets.length || voice.note.trim()
												? { note: voice.note.trim(), presets: voice.presets }
												: undefined,
									});
								}}
								{...testId("popcorn-run-button")}
							>
								<Trans>Run</Trans>
							</Button>
						</Group>
					</Stack>
				</Paper>
			</Stack>
		</PageContainer>
	);
}
