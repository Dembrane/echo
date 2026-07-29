import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Badge,
	Button,
	Checkbox,
	Group,
	Stack,
	Switch,
	Text,
	Textarea,
} from "@mantine/core";
import { IconArrowRight, IconCheck } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { SuggestionCardFrame } from "@/components/common/SuggestionCardFrame";
import { toast } from "@/components/common/Toaster";
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

const fieldLabel = (field: string) =>
	FIELD_LABELS[field]?.() ??
	field.replace(/^default_conversation_/, "").replace(/_/g, " ");

const isEmptyValue = (value: unknown) =>
	value === null || value === undefined || value === "";

const ValueText = ({
	value,
	kind,
}: {
	value: unknown;
	kind: "old" | "new";
}) => {
	if (isEmptyValue(value)) {
		return (
			<Text size="xs" component="span" fs="italic" c="graphite.5">
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
		) : typeof value === "object" ? (
			JSON.stringify(value)
		) : (
			String(value)
		);
	return (
		<Text
			size="xs"
			component="span"
			className={
				kind === "old"
					? "break-words text-red-800 line-through decoration-red-300"
					: "break-words text-green-900"
			}
		>
			{display}
		</Text>
	);
};

	/**
	 * A local input component that prevents keystroke-by-keystroke re-renders
	 * of the entire outer card and chat list. It buffers the value locally in state
	 * and only flushes it to the parent state on blur or unmount.
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

	/**
	 * Renders an agent-proposed settings change for the host to review.
 * The agent never writes; the host can fine-tune each proposed value, pick
 * which changes to keep, and apply them through the normal project PATCH
 * under their own session (the access ladder gates the write).
 *
 * Applied state is stateless: the card compares the live project values to
 * the proposal, so a reload still shows "Applied" truthfully.
 */
export const ProjectUpdateSuggestionCard = ({
	suggestion,
}: {
	suggestion: ProjectUpdateSuggestion;
}) => {
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
	const [dismissed, setDismissed] = useState(false);

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
											String(value)
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

	return (
		<SuggestionCardFrame testId="agentic-project-update-suggestion">
			<Stack gap="sm">
				<Group justify="space-between" wrap="nowrap">
					<Text size="sm" fw={600}>
						<Trans>Suggested changes for your project</Trans>
					</Text>
					{dismissed && (
						<Badge size="xs" variant="outline">
							<Trans>Dismissed</Trans>
						</Badge>
					)}
				</Group>
				{suggestion.summary && <Text size="xs">{suggestion.summary}</Text>}
				{!dismissed && (
					<Text size="xs" fs="italic" c="graphite.6">
						<Trans>
							Review each change below. You can edit the new text first. Nothing
							changes until you apply.
						</Trans>
					</Text>
				)}

				<Stack gap="md">
					{suggestion.changes.map((change) => {
						const value = effectiveValue(change);
						const isBoolean = typeof change.proposed === "boolean";
						const isEditable =
							!isBoolean && typeof change.proposed !== "object";
						return (
							<Group
								key={change.field}
								align="flex-start"
								gap="sm"
								wrap="nowrap"
							>
								{!dismissed && (
									<Checkbox
										size="sm"
										mt={2}
										checked={Boolean(selected[change.field])}
										onChange={(event) =>
											setSelected((prev) => ({
												...prev,
												[change.field]: event.currentTarget.checked,
											}))
										}
										{...testId(`suggestion-field-checkbox-${change.field}`)}
									/>
								)}
								<Stack gap={4} className="min-w-0 flex-1">
									<Text size="sm" fw={500}>
										{fieldLabel(change.field)}
									</Text>
									<Group gap={6} wrap="wrap" align="center">
										<ValueText value={change.current} kind="old" />
										<IconArrowRight
											size={12}
											className="shrink-0"
											style={{ color: "var(--mantine-color-primary-5)" }}
											aria-hidden
										/>
										{isBoolean ? (
											<Switch
												size="xs"
												checked={Boolean(value)}
												disabled={dismissed}
												onChange={(event) =>
													setEdited((prev) => ({
														...prev,
														[change.field]: event.currentTarget.checked,
													}))
												}
											/>
										) : !isEditable || dismissed ? (
											<ValueText value={value} kind="new" />
										) : null}
									</Group>
										{isEditable && !dismissed && (
											<BufferedTextarea
												size="xs"
												autosize
												minRows={1}
												maxRows={6}
												initialValue={String(value ?? "")}
												onFlush={(val) =>
													setEdited((prev) => ({
														...prev,
														[change.field]: val,
													}))
												}
												{...testId(`suggestion-field-input-${change.field}`)}
											/>
										)}
									{change.reason && (
										<Text size="xs" fs="italic" c="graphite.6">
											{change.reason}
										</Text>
									)}
								</Stack>
							</Group>
						);
					})}
				</Stack>

				{!dismissed && (
					<Group justify="flex-end" gap="sm">
						<Button
							variant="subtle"
							size="xs"
							onClick={() => setDismissed(true)}
							{...testId("suggestion-dismiss-button")}
						>
							<Trans>Not now</Trans>
						</Button>
						<Button
							size="xs"
							loading={updateProjectMutation.isPending}
							disabled={selectedChanges.length === 0}
							onClick={() => void handleApply()}
							{...testId("suggestion-apply-button")}
						>
							<Trans>Apply selected</Trans>
						</Button>
					</Group>
				)}
			</Stack>
		</SuggestionCardFrame>
	);
};
