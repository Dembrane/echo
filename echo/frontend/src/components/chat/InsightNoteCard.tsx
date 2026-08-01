import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Badge, Button, Group, Stack, Text, Textarea } from "@mantine/core";
import { LightbulbIcon, TrashIcon } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { SuggestionCardFrame } from "@/components/common/SuggestionCardFrame";
import type { SentAgentInsight } from "@/lib/api";
import { testId } from "@/lib/testUtils";
import type { ParsedInsightNote } from "./agenticToolActivity";

// Kept lowercase per brand: these read as quiet chips, not headings.
const kindLabel = (kind: ParsedInsightNote["kind"]): string => {
	switch (kind) {
		case "capability_gap":
			return t`capability gap`;
		case "friction":
			return t`friction`;
		case "wish":
			return t`wish`;
		case "praise":
			return t`praise`;
		default:
			return t`note`;
	}
};

// A short, host-referenceable handle: the host can say "edit insight a1b2".
const shortInsightId = (insightId: string): string =>
	insightId.replace(/[^a-z0-9]/gi, "").slice(0, 4) || insightId.slice(0, 4);

/** What the assistant drafted for the dembrane team, and what the host does
 * with it.
 *
 * The assistant never records an insight. It drafts one, and this card is where
 * the host reads it, edits the wording, adds anything of their own, and sends
 * it, or simply ignores it. Dismissing is local state only, like every other
 * proposal card: nothing was written, so there is nothing to undo.
 *
 * Sent state is stateless, on the model of CustomVerificationTopicSuggestionCard:
 * the card matches its (edited) content against the insights actually sent in
 * this project, so a reload still tells the truth and the host cannot send the
 * same note twice.
 *
 * Historical chats replay cards whose payload predates consent. Those arrive
 * with a mode of "noted", "edited" or "retracted" and an insightId, and they
 * keep their original read-only rendering. */
export const InsightNoteCard = ({
	note,
	sentInsights = [],
	onSend,
	isSending = false,
	dismissed = false,
	onDismiss,
	isDismissing = false,
}: {
	note: ParsedInsightNote;
	sentInsights?: SentAgentInsight[];
	onSend?: (content: string, suggestedCapability: string | null) => void;
	isSending?: boolean;
	dismissed?: boolean;
	onDismiss?: () => void;
	isDismissing?: boolean;
}) => {
	const [content, setContent] = useState(note.content);
	const [hostNote, setHostNote] = useState("");
	const [ignored, setIgnored] = useState(false);

	const retracted = note.mode === "retracted";
	const muted = retracted || dismissed;
	const edited = note.mode === "edited";
	const canDismiss = Boolean(onDismiss) && !dismissed && note.insightId;

	// A draft that matches something already sent is shown as sent, so a reload
	// never invites a second send of the same note.
	const sent = useMemo(() => {
		const target = content.trim();
		if (!target) return false;
		return sentInsights.some(
			(row) => row.status !== "archived" && (row.content ?? "").trim() === target,
		);
	}, [sentInsights, content]);

	const isDraft = note.mode === "proposed" && !sent;

	if (isDraft && ignored) return null;

	if (isDraft) {
		const canSend = Boolean(onSend) && content.trim().length > 0;
		return (
			<SuggestionCardFrame compact tight testId="agentic-insight-draft">
				<Stack gap="xs">
					<Group gap="xs" wrap="nowrap" align="center">
						<LightbulbIcon size={16} aria-hidden="true" />
						<Badge size="xs" variant="outline" radius="sm">
							{kindLabel(note.kind)}
						</Badge>
						<Text size="xs" c="dimmed">
							<Trans>for the dembrane team</Trans>
						</Text>
					</Group>
					<Text size="xs" c="dimmed">
						<Trans>
							Nothing is sent until you send it. Edit anything below first.
						</Trans>
					</Text>
					<Textarea
						value={content}
						onChange={(event) => setContent(event.currentTarget.value)}
						autosize
						minRows={2}
						size="xs"
						aria-label={t`What gets sent`}
						{...testId("agentic-insight-draft-content")}
					/>
					<Textarea
						value={hostNote}
						onChange={(event) => setHostNote(event.currentTarget.value)}
						autosize
						minRows={1}
						size="xs"
						placeholder={t`Anything you want to add`}
						aria-label={t`Anything you want to add`}
						{...testId("agentic-insight-draft-note")}
					/>
					{note.suggestedCapability ? (
						<Text size="xs" c="dimmed">
							{note.suggestedCapability}
						</Text>
					) : null}
					<Group gap="xs" justify="flex-end">
						<Button
							variant="subtle"
							color="gray"
							size="compact-xs"
							onClick={() => setIgnored(true)}
							{...testId("agentic-insight-draft-dismiss")}
						>
							<Trans>Not this one</Trans>
						</Button>
						<Button
							size="compact-xs"
							loading={isSending}
							disabled={!canSend}
							onClick={() => {
								const body = hostNote.trim()
									? `${content.trim()}\n\nFrom the host: ${hostNote.trim()}`
									: content.trim();
								onSend?.(body, note.suggestedCapability);
							}}
							{...testId("agentic-insight-draft-send")}
						>
							<Trans>Send to dembrane</Trans>
						</Button>
					</Group>
				</Stack>
			</SuggestionCardFrame>
		);
	}

	return (
		<SuggestionCardFrame compact tight testId="agentic-insight-note">
			<Stack gap="xs">
				<Group gap="xs" wrap="nowrap" align="center">
					<LightbulbIcon size={16} aria-hidden="true" opacity={muted ? 0.5 : 1} />
					<Badge
						size="xs"
						variant="outline"
						radius="sm"
						c={muted ? "dimmed" : undefined}
					>
						{kindLabel(note.kind)}
					</Badge>
					{edited && !dismissed ? (
						<Badge size="xs" variant="light" radius="sm">
							{t`updated`}
						</Badge>
					) : null}
					{retracted ? (
						<Badge size="xs" variant="light" color="gray" radius="sm">
							{t`retracted`}
						</Badge>
					) : null}
					{note.insightId ? (
						<Text size="xs" c="dimmed">
							{t`insight ${shortInsightId(note.insightId)}`}
						</Text>
					) : null}
					{canDismiss ? (
						<Button
							variant="outline"
							color="red"
							size="compact-xs"
							ml="auto"
							loading={isDismissing}
							rightSection={<TrashIcon size={14} />}
							aria-label={t`Remove`}
							onClick={onDismiss}
							{...testId("agentic-insight-note-remove")}
						>
							<Trans>Remove</Trans>
						</Button>
					) : null}
				</Group>
				{!dismissed ? (
					<Text size="sm" c={muted ? "dimmed" : undefined}>
						{sent ? content : note.content}
					</Text>
				) : null}
				{note.suggestedCapability && !muted ? (
					<Text size="xs" c="dimmed">
						{note.suggestedCapability}
					</Text>
				) : null}
				{retracted && note.reason ? (
					<Text size="xs" c="dimmed">
						{t`reason: ${note.reason}`}
					</Text>
				) : null}
				<Text size="xs" c={dismissed ? "red" : "dimmed"}>
					{dismissed
						? t`This insight has been deleted`
						: retracted
							? t`retracted for the dembrane team`
							: t`sent to the dembrane team`}
				</Text>
			</Stack>
		</SuggestionCardFrame>
	);
};
