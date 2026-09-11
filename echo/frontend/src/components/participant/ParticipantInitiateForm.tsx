import { zodResolver } from "@hookform/resolvers/zod";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Box,
	Button,
	Group,
	Loader,
	MultiSelect,
	Stack,
	TextInput,
} from "@mantine/core";
import { AxiosError } from "axios";
import posthog from "posthog-js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { useSearchParams } from "react-router";
import { z } from "zod";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { initiateConversation as requestConversation } from "@/lib/api";
import { testId } from "@/lib/testUtils";
import { getVisitorId } from "@/lib/visitorId";
import { useInitiateConversationMutation } from "./hooks";

const FormSchema = z.object({
	email: z.string().optional(),
	name: z.string().optional(),
	tagIdList: z.array(z.string()).default([]),
});

type FormValues = z.infer<typeof FormSchema>;

/** True when this screen has nothing to ask a participant.
 *
 * The only questions here are the session name and the tags, both of which a
 * host turns on per project. With neither, "Ready to Begin?" is a question
 * whose only answer is Continue, so the portal answers it itself and goes
 * straight from the mic check to recording. */
export const portalHasNothingToAsk = (project: Project) =>
	!project.default_conversation_ask_for_participant_name &&
	project.tags.length === 0;

/** The detail the server sent, or a generic apology. */
const initiateErrorMessage = (error: unknown): string => {
	const detail =
		error instanceof AxiosError ? error.response?.data?.detail : undefined;
	return typeof detail === "string" ? detail : t`Something went wrong`;
};

/** In-flight (or settled) auto-started conversations, keyed by project.
 *
 * Module scope on purpose: it has to outlive any one mount of this form. See
 * the effect that fills it. */
const autoStartedConversations = new Map<
	string,
	ReturnType<typeof requestConversation>
>();

export const ParticipantInitiateForm = ({ project }: { project: Project }) => {
	const navigate = useI18nNavigate();
	const [searchParams] = useSearchParams();

	const defaultName =
		searchParams.get("participant_name") ||
		searchParams.get("title") ||
		searchParams.get("name") ||
		"";
	const defaultEmail =
		searchParams.get("participant_email") || searchParams.get("email") || "";
	const defaultTagsParam =
		searchParams.get("tags") || searchParams.get("tag_id_list") || "";

	const defaultTagIdList = useMemo(() => {
		if (!defaultTagsParam) return [];
		const splitTags = defaultTagsParam
			.split(",")
			.map((t) => t.trim().toLowerCase());
		return (project.tags as unknown as ProjectTag[])
			.filter((tag) => tag && tag.id && tag.text)
			.filter(
				(tag) =>
					splitTags.includes(tag.id.toLowerCase()) ||
					splitTags.includes((tag.text ?? "").toLowerCase()),
			)
			.map((tag) => tag.id);
	}, [defaultTagsParam, project.tags]);

	const {
		register,
		setValue,
		handleSubmit,
		reset,
		formState: { errors },
	} = useForm<FormValues>({
		defaultValues: useMemo(
			() => ({
				email: defaultEmail,
				name: defaultName,
				tagIdList: defaultTagIdList,
			}),
			[defaultName, defaultEmail, defaultTagIdList],
		),
		resolver: zodResolver(FormSchema),
	});

	const { isSuccess, isError, ...initiateConversationMutation } =
		useInitiateConversationMutation();

	// Re-entrancy latch: isPending flips too late to block a fast double click
	// or a StrictMode double-invoke of the auto-submit effect.
	const hasInitiatedRef = useRef(false);

	const { mutate: initiateConversation } = initiateConversationMutation;

	const startConversation = useCallback(
		(data: FormValues) => {
			if (hasInitiatedRef.current) return;
			hasInitiatedRef.current = true;

			posthog.capture("conversation_started", {
				project_id: project.id,
				source: "PORTAL_AUDIO",
			});
			initiateConversation(
				{
					email: data.email || undefined,
					// `??` not `||`: an empty name is intentional when the project does
					// not ask for one, and keeps the dashboard's auto-title fallback
					name: data.name ?? t`Participant`,
					pin: "",
					projectId: project.id,
					source: "PORTAL_AUDIO",
					tagIdList: data.tagIdList,
					visitorId: getVisitorId(project.id),
				},
				{
					onError: () => {
						hasInitiatedRef.current = false;
					},
				},
			);
		},
		[project.id, initiateConversation],
	);

	const nothingToAsk = portalHasNothingToAsk(project);
	const [autoStartError, setAutoStartError] = useState<unknown>(null);

	const goToConversation = useCallback(
		(conversationId: string) => {
			const mode =
				searchParams.get("mode") ||
				(searchParams.get("general_feedback") || searchParams.get("feedback")
					? "text"
					: "audio");
			const pathSuffix = mode === "text" ? "/text" : "";
			const searchStr = searchParams.toString();
			const queryStr = searchStr ? `?${searchStr}` : "";

			navigate(
				`/${project.id}/conversation/${conversationId}${pathSuffix}${queryStr}`,
			);
		},
		[navigate, project.id, searchParams],
	);

	// Start on arrival when the host asked to skip onboarding and the required
	// fields are prefilled, or when there was never anything to ask.
	//
	// This deliberately bypasses the mutation hook. A component-scoped mutation
	// loses its result if the component is torn down mid-flight, which happens
	// on every mount under React's StrictMode and can happen in production
	// whenever this subtree re-renders into a new component identity: the POST
	// lands, a conversation exists, and the participant is left staring at the
	// screen that was supposed to send them onward. The promise lives in the
	// module instead, so a remounted form picks up the same request rather than
	// firing a second one.
	useEffect(() => {
		const skipOnboarding = searchParams.get("skipOnboarding") === "1";
		const hasRequiredName =
			!project.default_conversation_ask_for_participant_name || defaultName;

		if (!((skipOnboarding || nothingToAsk) && hasRequiredName)) return;

		let cancelled = false;
		let pending = autoStartedConversations.get(project.id);

		if (!pending) {
			posthog.capture("conversation_started", {
				project_id: project.id,
				source: "PORTAL_AUDIO",
			});
			pending = requestConversation({
				email: defaultEmail || undefined,
				name: defaultName || t`Participant`,
				pin: "",
				projectId: project.id,
				source: "PORTAL_AUDIO",
				tagIdList: defaultTagIdList,
				visitorId: getVisitorId(project.id),
			});
			autoStartedConversations.set(project.id, pending);
		}

		pending
			.then((conversation) => {
				// The entry exists to survive a remount while the request is in
				// flight, nothing longer. Coming back to this screen later (via
				// "Record another conversation", say) has to start a new one.
				autoStartedConversations.delete(project.id);
				if (cancelled || !conversation?.id) return;
				goToConversation(conversation.id);
			})
			.catch((error) => {
				// Let the participant retry with the Continue button.
				autoStartedConversations.delete(project.id);
				if (!cancelled) setAutoStartError(error);
			});

		return () => {
			cancelled = true;
		};
	}, [
		project.default_conversation_ask_for_participant_name,
		project.id,
		nothingToAsk,
		defaultName,
		defaultEmail,
		defaultTagIdList,
		searchParams,
		goToConversation,
	]);

	useEffect(() => {
		if (isSuccess) {
			if (initiateConversationMutation.data?.id) {
				goToConversation(initiateConversationMutation.data.id);
			} else {
				// release the latch so Continue works again
				hasInitiatedRef.current = false;
				reset();
			}
		}
	}, [isSuccess, initiateConversationMutation.data, reset, goToConversation]);

	useEffect(() => {
		if (isError) {
			reset();
		}
	}, [isError, reset]);

	return (
		<form
			onSubmit={handleSubmit(startConversation)}
			className="w-full"
			{...testId("portal-initiate-form")}
		>
			<Stack className="relative">
				{Boolean(initiateConversationMutation.error || autoStartError) && (
					<Box>
						<Alert
							color="red"
							variant="light"
							{...testId("portal-initiate-error-alert")}
						>
							{initiateErrorMessage(
								initiateConversationMutation.error ?? autoStartError,
							)}
						</Alert>
					</Box>
				)}

				{project.default_conversation_ask_for_participant_name && (
					<TextInput
						// this bug! haha. autoFocus was serioursly messing up the animations with the onboarding cards!
						// autoFocus
						required
						size="md"
						label={
							project.conversation_ask_for_participant_name_label ??
							t`Session Name`
						}
						placeholder="Group 1, John Doe, etc."
						{...register("name")}
						error={errors.name?.message}
						className="w-full"
						{...testId("portal-initiate-name-input")}
					/>
				)}
				{project.tags.length > 0 && (
					<MultiSelect
						label={t`Tags`}
						description={t`Add all that apply`}
						size="md"
						comboboxProps={{
							middlewares: { flip: false, shift: false },
							offset: 0,
							position: "top",
							withinPortal: false,
						}}
						data={(project.tags as unknown as ProjectTag[])
							.filter((tag) => tag && tag.text != null && tag.id != null)
							.map((tag) => ({
								label: tag.text ?? "",
								value: tag.id,
							}))}
						onChange={(value) => {
							setValue("tagIdList", value);
						}}
						className="w-full"
						{...testId("portal-initiate-tags-select")}
					/>
				)}
				{nothingToAsk &&
				!initiateConversationMutation.error &&
				!autoStartError ? (
					// Nothing was asked, so the conversation is already starting. The
					// button would only ever be pressed by the effect above; a spinner
					// is the honest version of that.
					<Group
						justify="center"
						py="md"
						{...testId("portal-initiate-starting")}
					>
						<Loader size="sm" />
					</Group>
				) : (
					<Button
						type="submit"
						size="lg"
						loading={initiateConversationMutation.isPending}
						fullWidth
						{...testId("portal-initiate-next-button")}
					>
						<Trans id="participant.ready.to.begin.button.text">Continue</Trans>
					</Button>
				)}
			</Stack>
		</form>
	);
};
