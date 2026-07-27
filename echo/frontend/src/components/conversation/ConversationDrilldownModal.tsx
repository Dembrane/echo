import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Button,
	Divider,
	Group,
	Modal,
	MultiSelect,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { TrashIcon } from "@phosphor-icons/react";
import { formatDistanceToNow } from "date-fns";
import posthog from "posthog-js";
import { useEffect, useMemo, useState } from "react";

import { ConfirmModal } from "@/components/common/ConfirmModal";
import { I18nLink } from "@/components/common/i18nLink";
import { toast } from "@/components/common/Toaster";
import {
	useDeleteConversationByIdMutation,
	useUpdateConversationByIdMutation,
	useUpdateConversationTagsMutation,
} from "@/components/conversation/hooks";
import { useProjectById } from "@/components/project/hooks";
import type {
	MonitorConversation,
	MonitorTimelineStep,
} from "@/hooks/useConversationMonitor";
import { isProblemState, StatePill } from "./StatePill";

const relativeTime = (stamp: string): string => {
	try {
		return formatDistanceToNow(new Date(stamp), { addSuffix: true });
	} catch {
		return stamp;
	}
};

// Backend timeline keys -> translated labels (journey stages, then recording).
const timelineLabel = (key: string): string => {
	switch (key) {
		case "scanned":
			return t`Scanned the QR`;
		case "terms":
			return t`Accepted terms`;
		case "mic_ok":
			return t`Mic checked`;
		case "mic_skipped":
			return t`Skipped mic check`;
		case "mic_blocked":
			return t`Mic blocked`;
		case "profile":
			return t`Entered details`;
		case "created":
			return t`Joined the conversation`;
		case "recording_started":
			return t`Started recording`;
		case "last_audio":
			return t`Last audio`;
		default:
			return key;
	}
};

const Timeline = ({ steps }: { steps: MonitorTimelineStep[] }) => {
	if (steps.length === 0) return null;
	return (
		<>
			<Divider />
			<Stack gap={4}>
				<Text size="sm" fw={500}>
					<Trans>Timeline</Trans>
				</Text>
				{steps.map((step) => (
					<Group
						key={`${step.key}-${step.at}`}
						gap="xs"
						justify="space-between"
						wrap="nowrap"
					>
						<Text size="xs">{timelineLabel(step.key)}</Text>
						<Text size="xs">{relativeTime(step.at)}</Text>
					</Group>
				))}
			</Stack>
			<Divider />
		</>
	);
};

const ConversationDrilldown = ({
	conversation,
	base,
	projectId,
	onClose,
}: {
	conversation: MonitorConversation;
	base: string | null;
	projectId: string;
	onClose: () => void;
}) => {
	const [name, setName] = useState(conversation.label ?? "");
	const [tagIds, setTagIds] = useState<string[]>(conversation.tag_ids);
	const [confirmOpened, confirm] = useDisclosure(false);

	const update = useUpdateConversationByIdMutation();
	const updateTags = useUpdateConversationTagsMutation();
	const del = useDeleteConversationByIdMutation();

	// Project tags for the editor (minimal payload: id + text + sort).
	const { data: project } = useProjectById({
		projectId,
		query: {
			deep: { tags: { _sort: "sort" } },
			fields: [{ tags: ["id", "text", "sort"] }],
		},
	});
	const tagOptions = useMemo(
		() =>
			((project?.tags as unknown as ProjectTag[]) ?? [])
				.filter((tag) => tag?.id != null && tag?.text != null)
				.map((tag) => ({ label: tag.text ?? "", value: tag.id ?? "" })),
		[project?.tags],
	);

	// Re-anchor to server values on change, without clobbering an in-progress edit.
	useEffect(() => {
		setName(conversation.label ?? "");
	}, [conversation.label]);
	const serverTagKey = conversation.tag_ids.join(",");
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-seed only when the server tag set changes
	useEffect(() => {
		setTagIds(conversation.tag_ids);
	}, [serverTagKey]);

	const saveName = () => {
		update.mutate(
			{ id: conversation.id, payload: { participant_name: name.trim() } },
			{
				onError: () => toast.error(t`Could not save`),
				onSuccess: () => {
					posthog.capture("monitor_participant_name_edited", {
						conversation_id: conversation.id,
						project_id: projectId,
					});
					toast.success(t`Saved`);
				},
			},
		);
	};

	const saveTags = (value: string[]) => {
		const previous = tagIds;
		setTagIds(value);
		updateTags.mutate(
			{
				conversationId: conversation.id,
				projectId,
				projectTagIdList: value,
			},
			{
				onError: () => {
					// Roll back the optimistic value; the server set won't change.
					setTagIds(previous);
					toast.error(t`Could not save tags`);
				},
				onSuccess: () =>
					posthog.capture("monitor_conversation_tags_edited", {
						conversation_id: conversation.id,
						project_id: projectId,
					}),
			},
		);
	};

	const handleDelete = () => {
		del.mutate(conversation.id, {
			onSuccess: () => {
				posthog.capture("monitor_conversation_deleted", {
					conversation_id: conversation.id,
					project_id: projectId,
				});
				confirm.close();
				onClose();
			},
		});
	};

	return (
		<Stack gap="md">
			<TextInput
				label={t`Participant name`}
				value={name}
				onChange={(event) => setName(event.currentTarget.value)}
				onBlur={() => {
					if (name.trim() !== (conversation.label ?? "").trim()) saveName();
				}}
			/>

			{tagOptions.length > 0 && (
				<MultiSelect
					label={t`Tags`}
					placeholder={tagIds.length === 0 ? t`Select tags` : undefined}
					data={tagOptions}
					value={tagIds}
					onChange={saveTags}
					searchable
					clearable
				/>
			)}

			{conversation.has_error && (
				<Text size="xs" c="red.7">
					<Trans>
						Some of the recent audio couldn't be transcribed. The recording is
						saved.
					</Trans>
				</Text>
			)}

			<Timeline steps={conversation.timeline} />

			<Group justify="space-between" align="center">
				{base && (
					<I18nLink
						to={`${base}/conversations/${conversation.id}`}
						className="no-underline"
						onClick={() =>
							posthog.capture("monitor_conversation_opened", {
								conversation_id: conversation.id,
								from_problem_state: isProblemState(conversation),
								participant_state: conversation.state,
								project_id: projectId,
								recording_health: conversation.recording_health,
								transcription_status: conversation.transcription_status,
							})
						}
					>
						<Button variant="subtle" size="xs">
							<Trans>Open conversation</Trans>
						</Button>
					</I18nLink>
				)}
				<Button
					variant="subtle"
					color="red"
					size="xs"
					leftSection={<TrashIcon size={15} />}
					onClick={confirm.open}
				>
					<Trans>Delete</Trans>
				</Button>
			</Group>

			<ConfirmModal
				opened={confirmOpened}
				onClose={confirm.close}
				onConfirm={handleDelete}
				title={t`Delete conversation`}
				message={
					<Trans>
						This removes the conversation from the project. This can't be
						undone.
					</Trans>
				}
				confirmLabel={<Trans>Delete</Trans>}
				confirmColor="red"
				loading={del.isPending}
				data-testid="monitor-delete-modal"
			/>
		</Stack>
	);
};

/** Shared conversation drilldown (funnel node + monitor row): rename, tags,
 * timeline, open-conversation link, and delete. */
export const ConversationDrilldownModal = ({
	conversation,
	base,
	projectId,
	onClose,
}: {
	conversation: MonitorConversation | null;
	base: string | null;
	projectId: string;
	onClose: () => void;
}) => {
	// Keep the last conversation on screen through the close animation, then
	// clear it on exit so the content doesn't blank out before the modal is gone.
	const [shown, setShown] = useState<MonitorConversation | null>(conversation);
	useEffect(() => {
		if (conversation) setShown(conversation);
	}, [conversation]);

	return (
		<Modal
			opened={conversation !== null}
			onClose={onClose}
			title={
				<Group gap="sm" align="center" wrap="nowrap">
					<Trans>Conversation</Trans>
					{shown && <StatePill state={shown.state} />}
				</Group>
			}
			centered
			size="md"
			onExitTransitionEnd={() => setShown(null)}
		>
			{shown && (
				<ConversationDrilldown
					conversation={shown}
					base={base}
					projectId={projectId}
					onClose={onClose}
				/>
			)}
		</Modal>
	);
};
