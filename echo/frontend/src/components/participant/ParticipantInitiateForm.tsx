import { zodResolver } from "@hookform/resolvers/zod";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Box,
	Button,
	MultiSelect,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { AxiosError } from "axios";
import posthog from "posthog-js";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { useSearchParams } from "react-router";
import { z } from "zod";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { testId } from "@/lib/testUtils";
import { getVisitorId } from "@/lib/visitorId";
import { useInitiateConversationMutation } from "./hooks";

const FormSchema = z.object({
	name: z.string().optional(),
	email: z.string().optional(),
	tagIdList: z.array(z.string()).default([]),
});

type FormValues = z.infer<typeof FormSchema>;

export const ParticipantInitiateForm = ({ project }: { project: Project }) => {
	const navigate = useI18nNavigate();
	const [searchParams] = useSearchParams();
	const [readyValues, setReadyValues] = useState<FormValues | null>(null);

	const defaultName =
		searchParams.get("participant_name") || searchParams.get("name") || "";
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
		resolver: zodResolver(FormSchema),
		defaultValues: useMemo(
			() => ({
				name: defaultName,
				email: defaultEmail,
				tagIdList: defaultTagIdList,
			}),
			[defaultName, defaultEmail, defaultTagIdList],
		),
	});

	const { isSuccess, isError, ...initiateConversationMutation } =
		useInitiateConversationMutation();

	const startConversation = (data: FormValues) => {
		posthog.capture("conversation_started", {
			project_id: project.id,
			source: "PORTAL_AUDIO",
		});
		initiateConversationMutation.mutate({
			name: data.name ?? t`Participant`,
			email: data.email || undefined,
			pin: "",
			projectId: project.id,
			source: "PORTAL_AUDIO",
			tagIdList: data.tagIdList,
			visitorId: getVisitorId(project.id),
		});
	};

	const onSubmit = (data: FormValues) => {
		setReadyValues(data);
	};

	// Auto-submit if skipOnboarding is requested and we have required fields prefilled
	useEffect(() => {
		const skipOnboarding = searchParams.get("skipOnboarding") === "1";
		const hasRequiredName =
			!project.default_conversation_ask_for_participant_name || defaultName;

		if (
			skipOnboarding &&
			hasRequiredName &&
			!initiateConversationMutation.isPending &&
			!isSuccess &&
			!isError
		) {
			initiateConversationMutation.mutate({
				name: defaultName || t`Participant`,
				email: defaultEmail || undefined,
				pin: "",
				projectId: project.id,
				source: "PORTAL_AUDIO",
				tagIdList: defaultTagIdList,
				visitorId: getVisitorId(project.id),
			});
		}
	}, [
		project.id,
		project.default_conversation_ask_for_participant_name,
		defaultName,
		defaultEmail,
		defaultTagIdList,
		isSuccess,
		isError,
		searchParams,
		initiateConversationMutation.isPending,
		initiateConversationMutation.mutate,
	]);

	useEffect(() => {
		if (isSuccess) {
			if (initiateConversationMutation.data?.id) {
				const mode =
					searchParams.get("mode") ||
					(searchParams.get("general_feedback") || searchParams.get("feedback")
						? "text"
						: "audio");
				const pathSuffix = mode === "text" ? "/text" : "";

				const searchStr = searchParams.toString();
				const queryStr = searchStr ? `?${searchStr}` : "";

				navigate(
					`/${project.id}/conversation/${initiateConversationMutation.data?.id}${pathSuffix}${queryStr}`,
				);
			} else {
				reset();
			}
		}
	}, [
		isSuccess,
		reset,
		initiateConversationMutation.data?.id,
		navigate,
		project.id,
		searchParams,
	]);

	useEffect(() => {
		if (isError) {
			setReadyValues(null);
			reset();
		}
	}, [isError, reset]);

	if (readyValues) {
		return (
			<Stack className="w-full" {...testId("portal-ready-to-record")}>
				<Title order={2}>
					<Trans>Ready to record</Trans>
				</Title>
				<Text size="lg">
					<Trans>Start when you are ready.</Trans>
				</Text>
				<Button
					size="lg"
					loading={initiateConversationMutation.isPending}
					fullWidth
					onClick={() => startConversation(readyValues)}
					{...testId("portal-ready-start-button")}
				>
					<Trans>Start recording</Trans>
				</Button>
			</Stack>
		);
	}

	return (
		<form
			onSubmit={handleSubmit(onSubmit)}
			className="w-full"
			{...testId("portal-initiate-form")}
		>
			<Stack className="relative">
				{initiateConversationMutation.error && (
					<Box>
						<Alert
							color="red"
							variant="light"
							{...testId("portal-initiate-error-alert")}
						>
							{(initiateConversationMutation.error instanceof AxiosError &&
								initiateConversationMutation.error.response?.data.detail) ??
								t`Something went wrong`}
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
				<Button
					type="submit"
					size="lg"
					loading={initiateConversationMutation.isPending}
					fullWidth
					{...testId("portal-initiate-next-button")}
				>
					<Trans id="participant.ready.to.begin.button.text">Next</Trans>
				</Button>
			</Stack>
		</form>
	);
};
