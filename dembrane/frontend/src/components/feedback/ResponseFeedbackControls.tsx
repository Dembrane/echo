import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Button,
	Chip,
	Group,
	Modal,
	Stack,
	Text,
	Textarea,
	Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { ThumbsDown, ThumbsUp } from "@phosphor-icons/react";
import posthog from "posthog-js";
import { useState } from "react";
import { toast } from "@/components/common/Toaster";
import {
	type FeedbackRating,
	type FeedbackTargetType,
	type ResponseFeedback,
	useClearResponseFeedbackMutation,
	useSetResponseFeedbackMutation,
} from "./hooks";
import { REASON_KEYS, type ReasonKey, reasonLabel } from "./reasons";

interface Props {
	targetType: FeedbackTargetType;
	targetId: string;
	allTargetIds?: string[];
	current?: ResponseFeedback;
	disabled?: boolean;
	analytics?: Record<string, unknown>;
}

export const ResponseFeedbackControls = ({
	targetType,
	targetId,
	allTargetIds,
	current,
	disabled,
	analytics,
}: Props) => {
	const [modalOpen, { open: openModal, close: closeModal }] =
		useDisclosure(false);
	const [reason, setReason] = useState<ReasonKey | null>(null);
	const [comment, setComment] = useState("");
	const setFeedback = useSetResponseFeedbackMutation();
	const clearFeedback = useClearResponseFeedbackMutation();

	const rating = current?.rating;
	const onError = () => toast.error(t`Could not save feedback`);

	const track = (
		next: FeedbackRating,
		extra?: { reasons: ReasonKey[]; comment?: string },
	) =>
		posthog.capture("response_feedback_submitted", {
			has_comment: Boolean(extra?.comment),
			rating: next,
			reasons: extra?.reasons ?? [],
			target_type: targetType,
			...analytics,
		});

	const record = (
		next: FeedbackRating,
		extra?: { reasons: ReasonKey[]; comment?: string },
		options?: { track?: boolean; onDone?: () => void },
	) => {
		setFeedback.mutate(
			{
				allTargetIds,
				comment: extra?.comment || undefined,
				rating: next,
				reasons: extra?.reasons ?? [],
				targetId,
				targetType,
			},
			{
				onError,
				onSuccess: () => {
					if (options?.track) track(next, extra);
					options?.onDone?.();
				},
			},
		);
	};

	const clear = () => {
		clearFeedback.mutate(
			{ allTargetIds, targetId, targetType },
			{
				onError,
				onSuccess: () =>
					posthog.capture("response_feedback_cleared", {
						target_type: targetType,
						...analytics,
					}),
			},
		);
		closeModal();
	};

	const busy = setFeedback.isPending || clearFeedback.isPending;
	// A downvote is saved once, on send or dismiss; the thumb fills right away.
	const shownRating = modalOpen ? "down" : rating;

	const onThumb = (next: FeedbackRating) => {
		if (rating === next) {
			clear();
			return;
		}
		if (next === "down") {
			setReason(null);
			setComment("");
			openModal();
		} else {
			record(next, undefined, { track: true });
			closeModal();
		}
	};

	const dismissModal = () => {
		if (modalOpen) record("down", undefined, { track: true });
		closeModal();
	};

	const toggleReason = (key: ReasonKey) =>
		setReason((prev) => (prev === key ? null : key));

	const canSend = reason !== null || comment.trim().length > 0;

	const send = () => {
		if (!canSend) return;
		record(
			"down",
			{ comment: comment.trim() || undefined, reasons: reason ? [reason] : [] },
			{ onDone: () => toast.success(t`Feedback sent`), track: true },
		);
		closeModal();
	};

	return (
		<>
			<Group gap="xs">
				<Tooltip label={t`Good response`}>
					<ActionIcon aria-label={t`Good response`}
						variant="subtle"
						color={shownRating === "up" ? "primary" : "gray"}
						disabled={disabled || busy}
						aria-pressed={shownRating === "up"}
						data-testid="response-feedback-up"
						onClick={() => onThumb("up")}
					>
						<ThumbsUp size={20} />
					</ActionIcon>
				</Tooltip>
				<Tooltip label={t`Poor response`}>
					<ActionIcon aria-label={t`Poor response`}
						variant="subtle"
						color={shownRating === "down" ? "primary" : "gray"}
						disabled={disabled || busy}
						aria-pressed={shownRating === "down"}
						data-testid="response-feedback-down"
						onClick={() => onThumb("down")}
					>
						<ThumbsDown size={20} />
					</ActionIcon>
				</Tooltip>
			</Group>
			<Modal
				opened={modalOpen}
				onClose={dismissModal}
				title={t`What went wrong?`}
				size="sm"
				centered
				data-testid="response-feedback-modal"
			>
				<Stack gap="md">
					{/* One reason at most; picking the chosen one again clears it. */}
					<Group>
						{REASON_KEYS.map((key) => (
							<Chip
								key={key}
								checked={reason === key}
								onChange={() => toggleReason(key)}
								data-testid={`response-feedback-reason-${key}`}
							>
								{reasonLabel(key)}
							</Chip>
						))}
					</Group>
					<Textarea
						label={t`Anything else?`}
						placeholder={t`Optional`}
						autosize
						minRows={4}
						maxRows={10}
						resize="none"
						maxLength={2000}
						value={comment}
						onChange={(e) => setComment(e.currentTarget.value)}
						data-testid="response-feedback-comment"
					/>
					<Text size="sm">
						<Trans>
							Your feedback and this response go to the dembrane team.
						</Trans>
					</Text>
					<Group justify="flex-start" gap="sm">
						<Button
							variant="filled"
							data-testid="response-feedback-send"
							disabled={!canSend}
							onClick={send}
						>
							<Trans>Send</Trans>
						</Button>
						<Button
							variant="subtle"
							color="gray"
							onClick={dismissModal}
							data-testid="response-feedback-modal-cancel"
						>
							<Trans>Skip</Trans>
						</Button>
					</Group>
				</Stack>
			</Modal>
		</>
	);
};
