import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	Box,
	Button,
	Checkbox,
	Group,
	Stack,
	Switch,
	Text,
	Textarea,
} from "@mantine/core";
import { IconCheck, IconChevronDown, IconChevronUp } from "@tabler/icons-react";
import { useId, useMemo, useState } from "react";
import { SuggestionCardFrame } from "@/components/common/SuggestionCardFrame";
import { toast } from "@/components/common/Toaster";
import {
	buildWordDiff,
	elideUnchangedRuns,
	needsWordDiff,
	type WordDiffChunk,
} from "@/components/common/wordDiff";
import {
	useProjectById,
	useUpdateProjectByIdMutation,
} from "@/components/project/hooks";
import { testId } from "@/lib/testUtils";

export type ProjectUpdateSuggestionChange = {
	field: string;
	current: unknown;
	proposed: unknown;
	reason: string;
};

export type ProjectUpdateSuggestion = {
	projectId: string;
	summary: string;
	changes: ProjectUpdateSuggestionChange[];
};

// Hosts see the portal editor's language, not backend field names.
const FIELD_LABELS: Record<string, () => string> = {
	anonymize_transcripts: () => t`Anonymise transcripts`,
	context: () => t`Project context`,
	conversation_title_prompt: () => t`Title guidance`,
	default_conversation_ask_for_participant_email: () =>
		t`Ask participants for their email`,
	default_conversation_ask_for_participant_name: () =>
		t`Ask participants for their name`,
	default_conversation_description: () => t`Portal description`,
	default_conversation_finish_text: () => t`Portal finish message`,
	default_conversation_title: () => t`Portal title`,
	default_conversation_transcript_prompt: () => t`Key terms`,
	default_conversation_tutorial_slug: () => t`Portal tutorial`,
	enable_ai_title_and_tags: () => t`Automatic titles and draft tags`,
	get_reply_mode: () => t`Reply mode`,
	get_reply_prompt: () => t`Reply guidance`,
	host_guide: () => t`Host guide`,
	image_generation_model: () => t`Image style`,
	is_conversation_allowed: () => t`Portal open for new conversations`,
	is_get_reply_enabled: () => t`Replies to participants`,
	is_project_notification_subscription_allowed: () =>
		t`Participant updates subscription`,
	is_verify_enabled: () => t`Participant verification`,
	is_verify_on_finish_enabled: () => t`Verification on the finish screen`,
	language: () => t`Portal language`,
	name: () => t`Project name`,
	selected_verification_key_list: () => t`Verification topics`,
	tutorial_slug: () => t`Tutorial`,
};

/**
 * What a field actually touches, in one sentence. Only fields whose reach is
 * wider than the setting screen they live on: the host cannot be expected to
 * know that project context is read by four different features.
 */
const FIELD_IMPACT: Record<string, () => string> = {
	anonymize_transcripts: () =>
		t`This changes how transcripts are stored from here on. Conversations already recorded keep the form they were saved in.`,
	context: () =>
		t`The project context is read by transcription, chat answers and canvas generation, so a change here reaches more than one screen.`,
	default_conversation_transcript_prompt: () =>
		t`Key terms tell transcription how to spell the names and words that matter in this project.`,
	host_guide: () =>
		t`The host guide is what facilitators read before they run a session.`,
	language: () =>
		t`This sets the language participants see in the portal, including the questions they are asked.`,
};

const fieldLabel = (field: string) =>
	FIELD_LABELS[field]?.() ??
	field.replace(/^default_conversation_/, "").replace(/_/g, " ");

const fieldImpact = (field: string) => FIELD_IMPACT[field]?.() ?? null;

/** Names the fields in the headline. Past three, the tail becomes a count so
 * the resting state stays one readable line. */
const summarizeFields = (fields: string[]) => {
	const labels = fields.map(fieldLabel);
	if (labels.length <= 3) return labels.join(", ");
	const names = labels.slice(0, 3).join(", ");
	const extra = labels.length - 3;
	return t`${names} and ${extra} more`;
};

const isEmptyValue = (value: unknown) =>
	value === null || value === undefined || value === "";

/** Coarse pointers need a 44px target; Mantine's xs controls are 30px. */
const COARSE_TAP_TARGET = "[@media(pointer:coarse)]:min-h-11";

const VALUE_BOX =
	"max-h-64 overflow-y-auto rounded-md border border-slate-200 px-2 py-1.5";

const asDisplayString = (value: unknown) => {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return "";
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
};

const ValueText = ({
	value,
	kind,
}: {
	value: unknown;
	kind: "old" | "new";
}) => {
	if (isEmptyValue(value)) {
		return (
			<Text size="sm" component="span" fs="italic">
				{kind === "old" ? <Trans>empty</Trans> : <Trans>cleared</Trans>}
			</Text>
		);
	}
	const display =
		typeof value === "boolean" ? (
			value ? (
				<Trans>on</Trans>
			) : (
				<Trans>off</Trans>
			)
		) : (
			asDisplayString(value)
		);
	return (
		<Text
			size="sm"
			component="span"
			className={
				kind === "old"
					? "break-words text-red-900 line-through decoration-red-400"
					: "break-words text-green-900"
			}
		>
			{display}
		</Text>
	);
};

/**
 * One side of a word diff. The same chunk list renders both sides: the
 * "current" side hides additions and strikes removals, the "proposed" side
 * hides removals and highlights additions. Reading them top to bottom shows
 * the previous version, the new version, and exactly which words moved.
 */
const WordDiffSide = ({
	chunks,
	side,
}: {
	chunks: WordDiffChunk[];
	side: "current" | "proposed";
}) => (
	<Text size="sm" className="whitespace-pre-wrap break-words">
		{chunks.map((chunk, index) => {
			if (side === "current" && chunk.added) return null;
			if (side === "proposed" && chunk.removed) return null;
			const className = chunk.removed
				? "bg-red-100 text-red-900 line-through decoration-red-400"
				: chunk.added
					? "bg-green-100 text-green-900"
					: chunk.elided
						? "italic"
						: undefined;
			return (
				// biome-ignore lint/suspicious/noArrayIndexKey: chunks are positional and the list is rebuilt whole
				<span key={index} className={className}>
					{chunk.value}
				</span>
			);
		})}
	</Text>
);

/**
 * A local input that prevents keystroke-by-keystroke re-renders of the whole
 * card and chat list. It buffers the value locally and flushes to the parent
 * on blur.
 */
const BufferedTextarea = ({
	initialValue,
	onFlush,
	...props
}: Omit<React.ComponentProps<typeof Textarea>, "value" | "onChange"> & {
	initialValue: string;
	onFlush: (val: string) => void;
}) => {
	const [localVal, setLocalVal] = useState(initialValue);

	return (
		<Textarea
			{...props}
			value={localVal}
			onChange={(event) => setLocalVal(event.currentTarget.value)}
			onBlur={() => onFlush(localVal)}
		/>
	);
};

/** The before and after for one field, with the difference marked. */
const ChangeDetail = ({
	change,
	value,
	editing,
	showFullText,
	onToggleFullText,
	onEditValue,
}: {
	change: ProjectUpdateSuggestionChange;
	value: unknown;
	editing: boolean;
	showFullText: boolean;
	onToggleFullText: () => void;
	onEditValue: (next: unknown) => void;
}) => {
	const isBoolean = typeof change.proposed === "boolean";
	const useWordDiff = !isBoolean && needsWordDiff(change.current, value);

	const diff = useMemo(() => {
		if (!useWordDiff) return null;
		return buildWordDiff(
			asDisplayString(change.current),
			asDisplayString(value),
		);
	}, [useWordDiff, change.current, value]);

	const elided = useMemo(
		() => (diff && !diff.unavailable ? elideUnchangedRuns(diff.chunks) : null),
		[diff],
	);
	const hasElision = Boolean(elided?.some((chunk) => chunk.elided));
	// `elided` is null when the diff could not be computed; fall back to the
	// plain before/after boxes rather than rendering an empty diff.
	const chunks = elided && showFullText ? (diff?.chunks ?? null) : elided;

	const unchanged = asDisplayString(change.current) === asDisplayString(value);

	return (
		<Stack gap={6}>
			{unchanged ? (
				<Text size="sm" fs="italic">
					<Trans>This field already holds the proposed value.</Trans>
				</Text>
			) : null}

			{chunks ? (
				<Text size="xs">
					<Plural
						value={diff?.addedWords ?? 0}
						one="# word added"
						other="# words added"
					/>
					{", "}
					<Plural
						value={diff?.removedWords ?? 0}
						one="# word removed"
						other="# words removed"
					/>
				</Text>
			) : null}

			<Stack gap={2}>
				<Text size="xs">
					<Trans>Current</Trans>
				</Text>
				<Box className={VALUE_BOX}>
					{chunks ? (
						<WordDiffSide chunks={chunks} side="current" />
					) : (
						<ValueText value={change.current} kind="old" />
					)}
				</Box>
			</Stack>

			<Stack gap={2}>
				<Text size="xs">
					<Trans>Proposed</Trans>
				</Text>
				{editing ? (
					<BufferedTextarea
						size="sm"
						autosize
						minRows={2}
						maxRows={10}
						initialValue={asDisplayString(value)}
						onFlush={onEditValue}
						{...testId(`suggestion-field-input-${change.field}`)}
					/>
				) : (
					<Box className={VALUE_BOX}>
						{isBoolean ? (
							<Switch
								size="sm"
								checked={Boolean(value)}
								onChange={(event) => onEditValue(event.currentTarget.checked)}
								label={
									<Text size="sm">
										{value ? <Trans>on</Trans> : <Trans>off</Trans>}
									</Text>
								}
							/>
						) : chunks ? (
							<WordDiffSide chunks={chunks} side="proposed" />
						) : (
							<ValueText value={value} kind="new" />
						)}
					</Box>
				)}
			</Stack>

			{hasElision && !editing ? (
				<Group gap="xs">
					<Button
						variant="subtle"
						size="xs"
						className={COARSE_TAP_TARGET}
						onClick={onToggleFullText}
					>
						{showFullText ? (
							<Trans>Show only what changed</Trans>
						) : (
							<Trans>Show the full text</Trans>
						)}
					</Button>
				</Group>
			) : null}
		</Stack>
	);
};

/**
 * Renders an agent-proposed settings change for the host to review.
 *
 * The card rests collapsed: it names what would change, says it is waiting on
 * the host, and offers accept, dismiss and a note back to the assistant.
 * Expanding shows, per field, the value the project holds now, the value being
 * proposed, and the words that differ between them. The agent never writes;
 * the host applies through the normal project PATCH under their own session
 * (the access ladder gates the write).
 *
 * Applying replaces a field wholesale, so the strikethrough on the current
 * value is doing real work: a proposal that rewrites the whole context shows
 * the whole current context struck through, which is the truth of what the
 * host is about to agree to.
 *
 * Applied state is stateless: the card compares the live project values to the
 * proposal, so a reload still shows "Applied" truthfully.
 */
export const ProjectUpdateSuggestionCard = ({
	suggestion,
	onSendNote,
}: {
	suggestion: ProjectUpdateSuggestion;
	/** Sends the host's note back into the chat so the assistant can revise. */
	onSendNote?: (message: string) => void | Promise<void>;
}) => {
	const panelId = useId();
	const updateProjectMutation = useUpdateProjectByIdMutation();
	const changedFields = useMemo(
		() => suggestion.changes.map((c) => c.field),
		[suggestion.changes],
	);
	const projectQuery = useProjectById({
		projectId: suggestion.projectId,
		query: { fields: ["id", ...(changedFields as (keyof Project)[])] },
	});

	const [selected, setSelected] = useState<Record<string, boolean>>(() =>
		Object.fromEntries(suggestion.changes.map((c) => [c.field, true])),
	);
	// Hosts can fine-tune proposed values before applying.
	const [edited, setEdited] = useState<Record<string, unknown>>({});
	const [editingFields, setEditingFields] = useState<Record<string, boolean>>(
		{},
	);
	const [fullTextFields, setFullTextFields] = useState<Record<string, boolean>>(
		{},
	);
	const [dismissed, setDismissed] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const [noteOpen, setNoteOpen] = useState(false);
	const [note, setNote] = useState("");

	const effectiveValue = (change: ProjectUpdateSuggestionChange) =>
		change.field in edited ? edited[change.field] : change.proposed;

	// Stateless applied detection: if the live project already matches every
	// proposed value, this suggestion has been applied (even after a reload).
	// biome-ignore lint/correctness/useExhaustiveDependencies: effectiveValue is stable over `edited`, which is listed
	const applied = useMemo(() => {
		const project = projectQuery.data as Record<string, unknown> | undefined;
		if (!project) return false;
		return suggestion.changes.every((change) => {
			const live = project[change.field];
			const target = effectiveValue(change);
			return String(live ?? "") === String(target ?? "");
		});
	}, [projectQuery.data, suggestion.changes, edited]);

	const selectedChanges = useMemo(
		() => suggestion.changes.filter((c) => selected[c.field]),
		[suggestion.changes, selected],
	);

	const headlineFields = useMemo(
		() => summarizeFields(changedFields),
		[changedFields],
	);
	const selectedCount = selectedChanges.length;
	const totalCount = suggestion.changes.length;

	// The one impact worth saying before the host expands anything. Context wins
	// when it is in the set: it is the field that reaches furthest.
	const restingImpact = useMemo(() => {
		const field = changedFields.includes("context")
			? "context"
			: changedFields.find((name) => FIELD_IMPACT[name]);
		return field ? fieldImpact(field) : null;
	}, [changedFields]);

	const handleApply = async () => {
		if (selectedChanges.length === 0) return;
		const payload = Object.fromEntries(
			selectedChanges.map((c) => [c.field, effectiveValue(c)]),
		);
		try {
			await updateProjectMutation.mutateAsync({
				id: suggestion.projectId,
				payload,
			});
			await projectQuery.refetch();
			toast.success(
				t`Changes applied. You can fine-tune them anytime in project settings.`,
			);
		} catch {
			toast.error(t`Could not apply the changes. Nothing was saved.`);
		}
	};

	const handleSendNote = async () => {
		const hostNote = note.trim();
		if (!hostNote || !onSendNote) return;
		setNoteOpen(false);
		setNote("");
		// The note goes back as the host's own chat message, with just enough
		// context for the assistant to know which proposal it answers.
		await onSendNote(t`About the suggested project update: ${hostNote}`);
	};

	if (applied) {
		return (
			<SuggestionCardFrame compact testId="agentic-project-update-suggestion">
				<Stack gap="xs">
					<Group gap="xs" wrap="nowrap">
						<IconCheck
							size={16}
							className="shrink-0"
							style={{ color: "var(--mantine-color-primary-7)" }}
						/>
						<Text size="sm">
							<Trans>These changes are applied to your project.</Trans>
						</Text>
					</Group>
					{/* Keep the record of what changed; a bare confirmation tells
						    the host nothing when they come back to the chat later.
						    Label-over-value rows in plain text: the green
						    key-value soup was unreadable. */}
					<Stack
						gap="sm"
						className="ml-6 border-l-2 pl-3"
						style={{ borderColor: "var(--mantine-color-primary-light)" }}
					>
						{suggestion.changes.map((change) => {
							const value = effectiveValue(change);
							return (
								<Stack key={change.field} gap={2}>
									<Text size="xs" fw={600}>
										{fieldLabel(change.field)}
									</Text>
									<Text size="sm" lineClamp={3}>
										{typeof value === "boolean" ? (
											value ? (
												<Trans>on</Trans>
											) : (
												<Trans>off</Trans>
											)
										) : isEmptyValue(value) ? (
											<Text component="span" size="sm" fs="italic">
												<Trans>cleared</Trans>
											</Text>
										) : (
											asDisplayString(value)
										)}
									</Text>
								</Stack>
							);
						})}
					</Stack>
				</Stack>
			</SuggestionCardFrame>
		);
	}

	if (dismissed) {
		return (
			<SuggestionCardFrame compact testId="agentic-project-update-suggestion">
				<Group justify="space-between" gap="xs" wrap="wrap">
					<Text size="sm">
						<Trans>Dismissed. Nothing was changed.</Trans>
					</Text>
					<Button
						variant="subtle"
						size="xs"
						className={COARSE_TAP_TARGET}
						onClick={() => setDismissed(false)}
					>
						<Trans>Review again</Trans>
					</Button>
				</Group>
			</SuggestionCardFrame>
		);
	}

	return (
		<SuggestionCardFrame testId="agentic-project-update-suggestion">
			<Stack gap="sm">
				<Text size="sm" fw={600}>
					<Trans>
						The assistant suggests updating {headlineFields}. Waiting on you.
					</Trans>
				</Text>
				{suggestion.summary ? (
					<Text size="sm">{suggestion.summary}</Text>
				) : null}
				{restingImpact ? (
					<Text size="sm" fs="italic">
						{restingImpact}
					</Text>
				) : null}
				<Text size="xs">
					<Trans>
						Nothing changes until you accept. Open the changes to see the
						current value next to the proposed one.
					</Trans>
				</Text>

				<div id={panelId} hidden={!expanded}>
					{expanded ? (
						<Stack gap="lg" className="pt-1">
							<Text size="xs">
								<Trans>Untick a field to leave it exactly as it is.</Trans>
							</Text>
							{suggestion.changes.map((change) => {
								const value = effectiveValue(change);
								const impact = fieldImpact(change.field);
								const isEditable =
									typeof change.proposed !== "boolean" &&
									typeof change.proposed !== "object";
								const editing = Boolean(editingFields[change.field]);
								return (
									<Stack key={change.field} gap="xs">
										<Group justify="space-between" gap="xs" wrap="nowrap">
											<Checkbox
												size="sm"
												className={`min-w-0 ${COARSE_TAP_TARGET}`}
												checked={Boolean(selected[change.field])}
												onChange={(event) => {
													// Read the DOM before the updater runs: React
													// clears currentTarget once the handler returns,
													// and a lazily applied updater then reads null.
													const checked = event.currentTarget.checked;
													setSelected((prev) => ({
														...prev,
														[change.field]: checked,
													}));
												}}
												label={
													<Text size="sm" fw={600}>
														{fieldLabel(change.field)}
													</Text>
												}
												{...testId(`suggestion-field-checkbox-${change.field}`)}
											/>
											{isEditable ? (
												<Button
													variant="subtle"
													size="xs"
													className={`shrink-0 ${COARSE_TAP_TARGET}`}
													onClick={() =>
														setEditingFields((prev) => ({
															...prev,
															[change.field]: !prev[change.field],
														}))
													}
													{...testId(`suggestion-field-edit-${change.field}`)}
												>
													{editing ? <Trans>Done</Trans> : <Trans>Edit</Trans>}
												</Button>
											) : null}
										</Group>
										<Stack gap="xs" className="pl-7">
											{change.reason ? (
												<Text size="sm">{change.reason}</Text>
											) : null}
											{impact ? (
												<Text size="sm" fs="italic">
													{impact}
												</Text>
											) : null}
											<ChangeDetail
												change={change}
												value={value}
												editing={editing}
												showFullText={Boolean(fullTextFields[change.field])}
												onToggleFullText={() =>
													setFullTextFields((prev) => ({
														...prev,
														[change.field]: !prev[change.field],
													}))
												}
												onEditValue={(next) =>
													setEdited((prev) => ({
														...prev,
														[change.field]: next,
													}))
												}
											/>
										</Stack>
									</Stack>
								);
							})}
						</Stack>
					) : null}
				</div>

				{noteOpen ? (
					<Stack gap="xs">
						<Textarea
							size="sm"
							autosize
							minRows={2}
							maxRows={6}
							label={t`Add a note`}
							placeholder={t`What should be different about this?`}
							value={note}
							onChange={(event) => setNote(event.currentTarget.value)}
							{...testId("suggestion-note-input")}
						/>
						<Group justify="flex-end" gap="xs">
							<Button
								variant="subtle"
								size="xs"
								className={COARSE_TAP_TARGET}
								onClick={() => {
									setNoteOpen(false);
									setNote("");
								}}
							>
								<Trans>Cancel</Trans>
							</Button>
							<Button
								size="xs"
								className={COARSE_TAP_TARGET}
								disabled={note.trim().length === 0}
								onClick={() => void handleSendNote()}
								{...testId("suggestion-note-send-button")}
							>
								<Trans>Send note</Trans>
							</Button>
						</Group>
					</Stack>
				) : null}

				{selectedCount !== totalCount ? (
					<Text size="xs">
						<Trans>
							{selectedCount} of {totalCount} fields selected. Accept applies
							only the ticked ones.
						</Trans>
					</Text>
				) : null}

				<Group justify="space-between" gap="xs" wrap="wrap">
					<Button
						variant="subtle"
						size="xs"
						className={COARSE_TAP_TARGET}
						aria-expanded={expanded}
						aria-controls={panelId}
						leftSection={
							expanded ? (
								<IconChevronUp size={14} aria-hidden />
							) : (
								<IconChevronDown size={14} aria-hidden />
							)
						}
						onClick={() => setExpanded((prev) => !prev)}
						{...testId("suggestion-expand-button")}
					>
						{expanded ? (
							<Trans>Hide the changes</Trans>
						) : (
							<Plural
								value={suggestion.changes.length}
								one="Show what changes (# field)"
								other="Show what changes (# fields)"
							/>
						)}
					</Button>
					<Group gap="xs" wrap="wrap">
						{onSendNote && !noteOpen ? (
							<Button
								variant="subtle"
								size="xs"
								className={COARSE_TAP_TARGET}
								onClick={() => setNoteOpen(true)}
								{...testId("suggestion-note-button")}
							>
								<Trans>Add a note</Trans>
							</Button>
						) : null}
						<Button
							variant="subtle"
							size="xs"
							className={COARSE_TAP_TARGET}
							onClick={() => setDismissed(true)}
							{...testId("suggestion-dismiss-button")}
						>
							<Trans>Dismiss</Trans>
						</Button>
						<Button
							size="xs"
							className={COARSE_TAP_TARGET}
							loading={updateProjectMutation.isPending}
							disabled={selectedChanges.length === 0}
							onClick={() => void handleApply()}
							{...testId("suggestion-apply-button")}
						>
							<Trans>Accept</Trans>
						</Button>
					</Group>
				</Group>
			</Stack>
		</SuggestionCardFrame>
	);
};
