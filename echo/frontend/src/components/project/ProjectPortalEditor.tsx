import { zodResolver } from "@hookform/resolvers/zod";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Badge,
	Box,
	Button,
	Checkbox,
	Divider,
	Group,
	InputDescription,
	NativeSelect,
	Paper,
	Stack,
	Switch,
	Text,
	Textarea,
	TextInput,
	Title,
} from "@mantine/core";
import { IconEye, IconEyeOff, IconRefresh, IconX } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { Resizable } from "re-resizable";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { useAutoSave } from "@/hooks/useAutoSave";
import { useLanguage } from "@/hooks/useLanguage";
import type { VerificationTopicsResponse } from "@/lib/api";
import { Logo } from "../common/Logo";
import { toast } from "../common/Toaster";
import { FormLabel } from "../form/FormLabel";
import { MarkdownWYSIWYG } from "../form/MarkdownWYSIWYG/MarkdownWYSIWYG";
import { SaveStatus } from "../form/SaveStatus";
import { TOPIC_ICON_MAP } from "../participant/verify/VerifySelection";
import { useUpdateProjectByIdMutation } from "./hooks";
import { useProjectSharingLink } from "./ProjectQRCode";
import { ProjectTagsInput } from "./ProjectTagsInput";

const FormSchema = z.object({
	default_conversation_ask_for_participant_name: z.boolean(),
	default_conversation_description: z.string(),
	default_conversation_finish_text: z.string(),
	default_conversation_title: z.string(),
	default_conversation_transcript_prompt: z.string(),
	default_conversation_tutorial_slug: z.string(),
	get_reply_mode: z.string(),
	get_reply_prompt: z.string(),
	is_get_reply_enabled: z.boolean(),
	is_project_notification_subscription_allowed: z.boolean(),
	is_verify_enabled: z.boolean(),
	language: z.enum(["en", "nl", "de", "fr", "es"]),
	verification_topics: z.array(z.string()),
});

type ProjectPortalFormValues = z.infer<typeof FormSchema>;

type LanguageCode = "de" | "en" | "es" | "fr" | "nl";

const LANGUAGE_TO_LOCALE: Record<LanguageCode, string> = {
	de: "de-DE",
	en: "en-US",
	es: "es-ES",
	fr: "fr-FR",
	nl: "nl-NL",
};

const localeFromIso = (iso?: string) =>
	iso ? LANGUAGE_TO_LOCALE[iso as LanguageCode] : undefined;

const normalizeTopicList = (topics: string[]): string[] =>
	Array.from(
		new Set(topics.map((topic) => topic.trim()).filter(Boolean)),
	).sort();

const ProperNounInput = ({
	value,
	onChange,
	isDirty,
}: {
	value: string;
	onChange: (value: string) => void;
	isDirty: boolean;
}) => {
	const [nouns, setNouns] = useState<string[]>([]);
	const [nounInput, setNounInput] = useState("");

	useEffect(() => {
		setNouns(
			value
				.split(",")
				.map((v) => v.trim())
				.filter(Boolean),
		);
	}, [value]);

	const handleAddNoun = () => {
		if (nounInput.trim()) {
			const newNouns = [
				...nouns,
				...nounInput
					.split(",")
					.map((noun) => noun.trim())
					.filter(Boolean),
			];
			const uniqueNouns = Array.from(new Set(newNouns));
			setNouns(uniqueNouns);
			onChange(uniqueNouns.join(", "));
			setNounInput("");
		}
	};

	const handleRemoveNoun = (noun: string) => {
		const newNouns = nouns.filter((n) => n !== noun);
		setNouns(newNouns);
		onChange(newNouns.join(", "));
	};

	return (
		<Stack gap="md">
			<TextInput
				className={isDirty ? "border-blue-500" : ""}
				label={<FormLabel label={t`Specific Context`} isDirty={isDirty} />}
				description={
					<Trans>
						Add key terms or proper nouns to improve transcript quality and
						accuracy.
					</Trans>
				}
				value={nounInput}
				onChange={(e) => setNounInput(e.currentTarget.value)}
				placeholder={t`Enter a key term or proper noun`}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						handleAddNoun();
					}
				}}
			/>
			<Group gap="xs">
				{nouns.map((noun) => (
					<Badge
						key={noun}
						variant="light"
						c="var(--app-text)"
						size="lg"
						style={{
							fontWeight: 500,
							textTransform: "none",
						}}
						rightSection={
							<ActionIcon
								onClick={() => handleRemoveNoun(noun)}
								size="xs"
								variant="transparent"
								c="gray.8"
							>
								<IconX size={14} />
							</ActionIcon>
						}
					>
						<span>{noun}</span>
					</Badge>
				))}
			</Group>
		</Stack>
	);
};

// Memoized MarkdownWYSIWYG wrapper
const MemoizedMarkdownWYSIWYG = memo(MarkdownWYSIWYG);

// Memoized ProjectTagsInput wrapper
const MemoizedProjectTagsInput = memo(ProjectTagsInput);

type ProjectPortalEditorProps = {
	project: Project;
	verificationTopics: VerificationTopicsResponse;
	isVerificationTopicsLoading?: boolean;
};

const ProjectPortalEditorComponent: React.FC<ProjectPortalEditorProps> = ({
	project,
	verificationTopics,
	isVerificationTopicsLoading = false,
}) => {
	const queryClient = useQueryClient();
	const [showPreview, setShowPreview] = useState(false);
	const link = useProjectSharingLink(project);
	const [previewKey, setPreviewKey] = useState(0);
	const [previewWidth, setPreviewWidth] = useState(400);
	const [previewHeight, setPreviewHeight] = useState(300);
	const savedTopicsRef = useRef<string | null>(null);

	const projectLanguageCode = (project.language ?? "en") as
		| "en"
		| "nl"
		| "de"
		| "fr"
		| "es";
	const { iso639_1: uiLanguageIso } = useLanguage();
	const translationLocale =
		localeFromIso(uiLanguageIso) ??
		localeFromIso(projectLanguageCode) ??
		LANGUAGE_TO_LOCALE.en;

	const availableVerifyTopics = useMemo(
		() =>
			(verificationTopics?.available_topics ?? []).map((topic) => ({
				icon:
					TOPIC_ICON_MAP[topic.key] ??
					(topic.icon && !topic.icon.startsWith(":") ? topic.icon : undefined),
				key: topic.key,
				label:
					topic.translations?.[translationLocale]?.label ??
					topic.translations?.["en-US"]?.label ??
					topic.key,
			})),
		[verificationTopics, translationLocale],
	);

	const selectedTopicDefaults = useMemo(
		() => verificationTopics?.selected_topics ?? [],
		[verificationTopics],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: just a dependency issue biome catches, not an issue though
	const defaultValues = useMemo(() => {
		const rawTutorialSlug =
			project.default_conversation_tutorial_slug?.toLowerCase();
		const validSlugs = ["skip-consent", "none", "basic", "advanced"];
		const normalizedTutorialSlug = validSlugs.includes(rawTutorialSlug || "")
			? rawTutorialSlug
			: "none";

		return {
			default_conversation_ask_for_participant_name:
				project.default_conversation_ask_for_participant_name ?? false,
			default_conversation_description:
				project.default_conversation_description ?? "",
			default_conversation_finish_text:
				project.default_conversation_finish_text ?? "",
			default_conversation_title: project.default_conversation_title ?? "",
			default_conversation_transcript_prompt:
				project.default_conversation_transcript_prompt ?? "",
			default_conversation_tutorial_slug: normalizedTutorialSlug ?? "none",
			get_reply_mode: project.get_reply_mode ?? "summarize",
			get_reply_prompt: project.get_reply_prompt ?? "",
			is_get_reply_enabled: project.is_get_reply_enabled ?? false,
			is_project_notification_subscription_allowed:
				project.is_project_notification_subscription_allowed ?? false,
			is_verify_enabled: project.is_verify_enabled ?? false,
			language: projectLanguageCode,
			verification_topics: selectedTopicDefaults,
		};
	}, [project.id, projectLanguageCode, selectedTopicDefaults]);

	const formResolver = useMemo(() => zodResolver(FormSchema), []);

	const {
		control,
		handleSubmit,
		watch,
		formState,
		reset,
		setValue,
		getValues,
	} = useForm<ProjectPortalFormValues>({
		defaultValues,
		mode: "onChange",
		// for validation
		resolver: formResolver,
		reValidateMode: "onChange",
	});

	const watchedReplyMode = useWatch({
		control,
		name: "get_reply_mode",
	});

	const watchedReplyEnabled = useWatch({
		control,
		name: "is_get_reply_enabled",
	});

	const watchedVerifyEnabled = useWatch({
		control,
		name: "is_verify_enabled",
	});

	const updateProjectMutation = useUpdateProjectByIdMutation();

	const onSave = useCallback(
		async (values: ProjectPortalFormValues) => {
			const { verification_topics, ...projectPayload } = values;
			const normalizedTopics = normalizeTopicList(verification_topics);
			const serializedTopics =
				normalizedTopics.length > 0 ? normalizedTopics.join(",") : null;

			await updateProjectMutation.mutateAsync({
				id: project.id,
				payload: {
					...(projectPayload as Partial<Project>),
					selected_verification_key_list: serializedTopics,
				},
			});

			await queryClient.invalidateQueries({
				queryKey: ["verify", "topics", project.id],
			});

			// Store what we saved to detect when query refetches
			savedTopicsRef.current = normalizedTopics.join(",");

			reset(
				{
					...values,
					verification_topics: normalizedTopics,
				},
				{
					keepDirty: false,
					keepValues: true,
				},
			);
		},
		[project.id, updateProjectMutation, reset, queryClient],
	);

	const {
		dispatchAutoSave,
		triggerManualSave,
		isPendingSave,
		isSaving,
		isError,
		lastSavedAt,
	} = useAutoSave({
		initialLastSavedAt: project.updated_at ?? new Date(),
		onSave,
	});

	// Create a stable reference to dispatchAutoSave
	const dispatchAutoSaveRef = useRef(dispatchAutoSave);
	useEffect(() => {
		dispatchAutoSaveRef.current = dispatchAutoSave;
	}, [dispatchAutoSave]);

	useEffect(() => {
		if (!verificationTopics || isVerificationTopicsLoading) {
			return;
		}

		if (savedTopicsRef.current) {
			const normalizedSelected = normalizeTopicList(
				verificationTopics.selected_topics ?? [],
			);
			const savedTopicsNormalized = savedTopicsRef.current;

			if (normalizedSelected.join(",") === savedTopicsNormalized) {
				savedTopicsRef.current = null; // Clear flag, allow sync
			} else {
				return; // Still waiting for query to refetch
			}
		}

		if (formState.dirtyFields.verification_topics) {
			return;
		}

		const normalizedSelected = normalizeTopicList(
			verificationTopics.selected_topics ?? [],
		);
		const current = normalizeTopicList(getValues("verification_topics") ?? []);

		const differs =
			normalizedSelected.length !== current.length ||
			normalizedSelected.some((topic, index) => topic !== current[index]);

		if (differs) {
			setValue("verification_topics", normalizedSelected, {
				shouldDirty: false,
				shouldTouch: false,
			});
		}
	}, [
		formState.dirtyFields.verification_topics,
		getValues,
		setValue,
		verificationTopics,
		isVerificationTopicsLoading,
	]);

	useEffect(() => {
		const subscription = watch((values, { type }) => {
			if (type === "change" && values) {
				dispatchAutoSaveRef.current(values as ProjectPortalFormValues);
			}
		});

		return () => {
			subscription.unsubscribe();
		};
	}, [watch]); // Only depend on watch

	const refreshPreview = useCallback(() => {
		setPreviewKey((prev) => prev + 1);
	}, []);

	return (
		<Box>
			<Stack gap="3rem">
				<Group justify="space-between">
					<Group>
						<Title order={2}>
							<Trans>Portal Editor</Trans>
						</Title>
						<SaveStatus
							formErrors={formState.errors}
							savedAt={lastSavedAt}
							isPendingSave={isPendingSave}
							isSaving={isSaving}
							isError={isError}
						/>
					</Group>
					<Button
						variant="subtle"
						onClick={() => setShowPreview(!showPreview)}
						leftSection={
							showPreview ? <IconEyeOff size={16} /> : <IconEye size={16} />
						}
					>
						<Trans>{showPreview ? "Hide Preview" : "Show Preview"}</Trans>
					</Button>
				</Group>

				<div className="relative flex h-auto flex-col gap-8 lg:flex-row lg:justify-start">
					<div className="max-w-[800px] flex-1">
						<form
							onSubmit={handleSubmit(async (values) => {
								await triggerManualSave(values);
							})}
						>
							<Stack gap="3rem">
								<Stack gap="1.5rem">
									<Title order={3}>
										<Trans>Basic Settings</Trans>
									</Title>
									<Stack gap="2rem">
										<Controller
											name="language"
											control={control}
											render={({ field }) => (
												<NativeSelect
													label={
														<FormLabel
															label={t`Language`}
															isDirty={formState.dirtyFields.language}
															error={formState.errors.language?.message}
														/>
													}
													description={t`This language will be used for the Participant's Portal.`}
													data={[
														{ label: t`English`, value: "en" },
														{ label: t`Dutch`, value: "nl" },
														{ label: t`German`, value: "de" },
														{ label: t`Spanish`, value: "es" },
														{ label: t`French`, value: "fr" },
													]}
													{...field}
												/>
											)}
										/>
										<Controller
											name="default_conversation_ask_for_participant_name"
											control={control}
											render={({ field }) => (
												<Checkbox
													label={
														<FormLabel
															label={t`Ask for Name?`}
															isDirty={
																formState.dirtyFields
																	.default_conversation_ask_for_participant_name
															}
															error={
																formState.errors
																	.default_conversation_ask_for_participant_name
																	?.message
															}
														/>
													}
													description={
														<Trans>
															Ask participants to provide their name when they
															start a conversation
														</Trans>
													}
													checked={field.value}
													onChange={(e) =>
														field.onChange(e.currentTarget.checked)
													}
												/>
											)}
										/>
										<Controller
											name="default_conversation_tutorial_slug"
											control={control}
											render={({ field }) => (
												<NativeSelect
													label={
														<FormLabel
															label={t`Select tutorial`}
															isDirty={
																formState.dirtyFields
																	.default_conversation_tutorial_slug
															}
															error={
																formState.errors
																	.default_conversation_tutorial_slug?.message
															}
														/>
													}
													description={
														<Trans>
															Select the instructions that will be shown to
															participants when they start a conversation
														</Trans>
													}
													data={[
														{
															label: t`Skip data privacy slide (Host manages legal base)`,
															value: "skip-consent",
														},
														{
															label: t`Default - No tutorial (Only privacy statements)`,
															value: "none",
														},
														{
															label: t`Basic (Essential tutorial slides)`,
															value: "basic",
														},
														{
															label: t`Advanced (Tips and best practices)`,
															value: "advanced",
														},
													]}
													{...field}
												/>
											)}
										/>
										<MemoizedProjectTagsInput project={project} />
									</Stack>
								</Stack>

								<Divider />
								<Stack gap="1.5rem">
									<Title order={3}>
										<Trans>Participant Features</Trans>
									</Title>
									<Stack gap="2.5rem">
										<Stack gap="md">
											<Group>
												<Title order={4}>
													<Trans>Go deeper</Trans>
												</Title>
												<Logo hideTitle />
												<Badge>
													<Trans id="dashboard.dembrane.concrete.beta">
														Beta
													</Trans>
												</Badge>
											</Group>

											<Text size="sm" c="dimmed">
												<Trans>
													Enable this feature to allow participants to request
													AI-powered responses during their conversation.
													Participants can click "Go deeper" after recording
													their thoughts to receive contextual feedback,
													encouraging deeper reflection and engagement. A
													cooldown period applies between requests.
												</Trans>
											</Text>

											<Controller
												name="is_get_reply_enabled"
												control={control}
												render={({ field }) => (
													<Switch
														label={
															<FormLabel
																label={t`Enable Go deeper`}
																isDirty={
																	formState.dirtyFields.is_get_reply_enabled
																}
																error={
																	formState.errors.is_get_reply_enabled?.message
																}
															/>
														}
														checked={field.value}
														onChange={(e) =>
															field.onChange(e.currentTarget.checked)
														}
													/>
												)}
											/>

											<Controller
												name="get_reply_mode"
												control={control}
												render={({ field }) => (
													<Stack gap="xs">
														<FormLabel
															label={t`Mode`}
															isDirty={formState.dirtyFields.get_reply_mode}
															error={formState.errors.get_reply_mode?.message}
														/>
														<Text size="sm" c="dimmed">
															<Trans>
																Select the type of feedback or engagement you
																want to encourage.
															</Trans>
														</Text>
														<Group gap="xs">
															<Badge
																className={
																	watchedReplyEnabled
																		? "cursor-pointer capitalize"
																		: "capitalize"
																}
																variant={
																	field.value === "summarize"
																		? "light"
																		: "default"
																}
																c="var(--app-text)"
																size="lg"
																fw={500}
																style={{
																	border:
																		field.value === "summarize"
																			? "1px solid var(--mantine-color-primary-5)"
																			: "",
																	cursor: watchedReplyEnabled
																		? "pointer"
																		: "not-allowed",
																	opacity: watchedReplyEnabled ? 1 : 0.6,
																}}
																onClick={() =>
																	watchedReplyEnabled &&
																	field.onChange("summarize")
																}
															>
																<Trans>Default</Trans>
															</Badge>
															<Badge
																className={
																	watchedReplyEnabled
																		? "cursor-pointer capitalize"
																		: "capitalize"
																}
																variant={
																	field.value === "brainstorm"
																		? "light"
																		: "default"
																}
																c="var(--app-text)"
																size="lg"
																fw={500}
																style={{
																	border:
																		field.value === "brainstorm"
																			? "1px solid var(--mantine-color-primary-5)"
																			: "",
																	cursor: watchedReplyEnabled
																		? "pointer"
																		: "not-allowed",
																	opacity: watchedReplyEnabled ? 1 : 0.6,
																}}
																onClick={() =>
																	watchedReplyEnabled &&
																	field.onChange("brainstorm")
																}
															>
																<Trans>Brainstorm Ideas</Trans>
															</Badge>
															<Badge
																className={
																	watchedReplyEnabled
																		? "cursor-pointer capitalize"
																		: "capitalize"
																}
																variant={
																	field.value === "custom" ? "light" : "default"
																}
																c="var(--app-text)"
																size="lg"
																fw={500}
																style={{
																	border:
																		field.value === "custom"
																			? "1px solid var(--mantine-color-primary-5)"
																			: "",
																	cursor: watchedReplyEnabled
																		? "pointer"
																		: "not-allowed",
																	opacity: watchedReplyEnabled ? 1 : 0.6,
																}}
																onClick={() =>
																	watchedReplyEnabled &&
																	field.onChange("custom")
																}
															>
																<Trans>Custom</Trans>
															</Badge>
														</Group>
													</Stack>
												)}
											/>

											{watchedReplyMode === "custom" && (
												<Controller
													name="get_reply_prompt"
													control={control}
													render={({ field }) => (
														<Textarea
															label={
																<FormLabel
																	label={t`Reply Prompt`}
																	isDirty={
																		formState.dirtyFields.get_reply_prompt
																	}
																	error={
																		formState.errors.get_reply_prompt?.message
																	}
																/>
															}
															description={
																<Box className="pb-2">
																	<Trans>
																		This prompt guides how the AI responds to
																		participants. Customize it to shape the type
																		of feedback or engagement you want to
																		encourage.
																	</Trans>
																</Box>
															}
															autosize
															minRows={5}
															disabled={!watchedReplyEnabled}
															{...field}
														/>
													)}
												/>
											)}
										</Stack>

										<Stack gap="md">
											<Group>
												<Title order={4}>
													<Trans id="dashboard.dembrane.concrete.title">
														Make it concrete
													</Trans>
												</Title>
												<Logo hideTitle />
												<Badge>
													<Trans id="dashboard.dembrane.concrete.beta">
														Beta
													</Trans>
												</Badge>
											</Group>

											<Text size="sm" c="dimmed">
												<Trans id="dashboard.dembrane.concrete.description">
													Enable this feature to allow participants to create
													and approve "concrete objects" from their submissions.
													This helps crystallize key ideas, concerns, or
													summaries. After the conversation, you can filter for
													discussions with concrete objects and review them in
													the overview.
												</Trans>
											</Text>

											<Controller
												name="is_verify_enabled"
												control={control}
												render={({ field }) => (
													<Switch
														label={
															<FormLabel
																label={t`Enable Make it concrete`}
																isDirty={
																	formState.dirtyFields.is_verify_enabled
																}
																error={
																	formState.errors.is_verify_enabled?.message
																}
															/>
														}
														checked={field.value}
														onChange={(e) =>
															field.onChange(e.currentTarget.checked)
														}
													/>
												)}
											/>

											<Controller
												name="verification_topics"
												control={control}
												render={({ field }) => (
													<Stack gap="xs">
														<FormLabel
															label={t`Concrete Topics`}
															isDirty={
																!!formState.dirtyFields.verification_topics
															}
															error={
																formState.errors.verification_topics?.message
															}
														/>
														<Text size="sm" c="dimmed">
															<Trans id="dashboard.dembrane.concrete.topic.select">
																Select which topics participants can use for
																"Make it concrete".
															</Trans>
														</Text>
														{isVerificationTopicsLoading ? (
															<Text size="sm" c="dimmed">
																<Trans>Loading concrete topics…</Trans>
															</Text>
														) : availableVerifyTopics.length === 0 ? (
															<Text size="sm" c="dimmed">
																<Trans>No concrete topics available.</Trans>
															</Text>
														) : (
															<Group gap="xs">
																{availableVerifyTopics.map((topic) => (
																	<Badge
																		key={topic.key}
																		className={
																			watchedVerifyEnabled
																				? "cursor-pointer capitalize"
																				: "capitalize"
																		}
																		variant={
																			field.value.includes(topic.key)
																				? "light"
																				: "default"
																		}
																		c="var(--app-text)"
																		size="lg"
																		fw={500}
																		style={{
																			border: field.value.includes(topic.key)
																				? "1px solid var(--mantine-color-primary-5)"
																				: "",
																			cursor: watchedVerifyEnabled
																				? "pointer"
																				: "not-allowed",
																			opacity: watchedVerifyEnabled ? 1 : 0.6,
																		}}
																		onClick={() => {
																			if (!watchedVerifyEnabled) return;
																			const normalizedCurrent =
																				normalizeTopicList(field.value ?? []);
																			const isSelected =
																				normalizedCurrent.includes(topic.key);

																			// Prevent deselecting the last topic
																			if (
																				isSelected &&
																				normalizedCurrent.length === 1
																			) {
																				toast.error(
																					t`At least one topic must be selected to enable Make it concrete`,
																				);
																				return;
																			}

																			const updated = isSelected
																				? normalizedCurrent.filter(
																						(item) => item !== topic.key,
																					)
																				: normalizeTopicList([
																						...normalizedCurrent,
																						topic.key,
																					]);
																			field.onChange(updated);
																		}}
																	>
																		<Group gap="xs">
																			{topic.icon ? (
																				<span>{topic.icon}</span>
																			) : null}
																			<span>{topic.label}</span>
																		</Group>
																	</Badge>
																))}
															</Group>
														)}
													</Stack>
												)}
											/>
										</Stack>

										<Stack gap="md">
											<Group>
												<Title order={4}>
													<Trans>Report Notifications</Trans>
												</Title>
												<Text size="sm" c="dimmed">
													<Trans>
														Enable this feature to allow participants to receive
														notifications when a report is published or updated.
														Participants can enter their email to subscribe for
														updates and stay informed.
													</Trans>
												</Text>
											</Group>
											<Controller
												name="is_project_notification_subscription_allowed"
												control={control}
												render={({ field }) => (
													<Stack>
														<Switch
															label={
																<FormLabel
																	label={t`Enable Report Notifications`}
																	isDirty={
																		formState.dirtyFields
																			.is_project_notification_subscription_allowed
																	}
																	error={
																		formState.errors
																			.is_project_notification_subscription_allowed
																			?.message
																	}
																/>
															}
															checked={field.value}
															onChange={(e) =>
																field.onChange(e.currentTarget.checked)
															}
														/>
													</Stack>
												)}
											/>
										</Stack>
									</Stack>
								</Stack>
								<Divider />

								<Stack gap="1.5rem">
									<Title order={3}>
										<Trans>Portal Content</Trans>
									</Title>
									<Stack gap="2rem">
										<Controller
											name="default_conversation_title"
											control={control}
											render={({ field }) => (
												<TextInput
													label={
														<FormLabel
															label={t`Page Title`}
															isDirty={
																formState.dirtyFields.default_conversation_title
															}
															error={
																formState.errors.default_conversation_title
																	?.message
															}
														/>
													}
													description={
														<Trans>
															This title is shown to participants when they
															start a conversation
														</Trans>
													}
													{...field}
												/>
											)}
										/>

										<Stack gap="xs">
											<FormLabel
												label={t`Page Content`}
												isDirty={
													formState.dirtyFields.default_conversation_description
												}
												error={
													formState.errors.default_conversation_description
														?.message
												}
											/>
											<InputDescription>
												<Trans>
													This page is shown to participants when they start a
													conversation after they successfully complete the
													tutorial.
												</Trans>
											</InputDescription>
											<Controller
												name="default_conversation_description"
												control={control}
												render={({ field }) => (
													<MemoizedMarkdownWYSIWYG
														markdown={field.value}
														onChange={field.onChange}
													/>
												)}
											/>
										</Stack>

										<Stack gap="xs">
											<FormLabel
												label={t`Thank You Page Content`}
												isDirty={
													formState.dirtyFields.default_conversation_finish_text
												}
												error={
													formState.errors.default_conversation_finish_text
														?.message
												}
											/>
											<InputDescription>
												<Trans>
													This page is shown after the participant has completed
													the conversation.
												</Trans>
											</InputDescription>
											<Controller
												name="default_conversation_finish_text"
												control={control}
												render={({ field }) => (
													<MemoizedMarkdownWYSIWYG
														markdown={field.value}
														onChange={field.onChange}
													/>
												)}
											/>
										</Stack>
									</Stack>
								</Stack>

								<Divider />

								<Stack gap="1.5rem">
									<Title order={3}>
										<Trans>Advanced Settings</Trans>
									</Title>
									<Controller
										name="default_conversation_transcript_prompt"
										control={control}
										render={({ field }) => (
											<ProperNounInput
												isDirty={
													formState.dirtyFields
														.default_conversation_transcript_prompt ?? false
												}
												value={field.value}
												onChange={field.onChange}
											/>
										)}
									/>
								</Stack>

								<Divider />
							</Stack>
						</form>
					</div>

					{showPreview && link && (
						<div className="relative">
							<div className="sticky top-4 min-h-[60vh]">
								<Resizable
									size={{ height: previewHeight, width: previewWidth }}
									minWidth={300}
									maxWidth={500}
									minHeight="70vh"
									maxHeight="100vh"
									onResizeStop={(_e, _direction, _ref, d) => {
										setPreviewWidth(previewWidth + d.width);
										setPreviewHeight(previewHeight + d.height);
									}}
									enable={{
										bottom: true,
										bottomLeft: false,
										bottomRight: false,
										left: true,
										right: false,
										top: false,
										topLeft: false,
										topRight: false,
									}}
									handleStyles={{
										bottom: {
											bottom: "-4px",
											cursor: "row-resize",
											height: "8px",
										},
										left: {
											cursor: "col-resize",
											left: "-4px",
											width: "8px",
										},
									}}
									handleClasses={{
										bottom: "hover:bg-blue-500/20",
										left: "hover:bg-blue-500/20",
									}}
								>
									<Paper
										shadow="sm"
										withBorder
										className="flex h-full flex-col"
									>
										<Stack gap="xs" px="md" py="md">
											<Group justify="space-between">
												<Title order={4}>
													<Trans>Live Preview</Trans>
												</Title>
												<Button
													variant="subtle"
													size="compact-sm"
													onClick={refreshPreview}
													leftSection={<IconRefresh size={16} />}
												>
													<Trans>Refresh</Trans>
												</Button>
											</Group>
											<Text size="sm" c="dimmed">
												<Trans>
													This is a live preview of the participant's portal.
													You will need to refresh the page to see the latest
													changes.
												</Trans>
											</Text>
										</Stack>

										<Divider />

										<iframe
											key={previewKey}
											src={link}
											className="h-full w-full flex-1 bg-white"
											title="Portal Preview"
											allow="microphone *"
										/>
									</Paper>
								</Resizable>
							</div>
						</div>
					)}
				</div>
			</Stack>
		</Box>
	);
};

// Memoize the component to prevent re-renders when project hasn't changed
export const ProjectPortalEditor = memo(
	ProjectPortalEditorComponent,
	(prevProps, nextProps) => {
		// Only re-render if the project ID has changed
		return prevProps.project.id === nextProps.project.id;
	},
);
