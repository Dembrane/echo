import { zodResolver } from "@hookform/resolvers/zod";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Box,
	Button,
	MultiSelect,
	Stack,
	TextInput,
} from "@mantine/core";
import { AxiosError } from "axios";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { testId } from "@/lib/testUtils";
import { useInitiateConversationMutation } from "./hooks";

const FormSchema = z.object({
	name: z.string().optional(),
	tagIdList: z.array(z.string()).default([]),
});

type FormValues = z.infer<typeof FormSchema>;

export const ParticipantInitiateForm = ({ project }: { project: Project }) => {
	const navigate = useI18nNavigate();

	const {
		register,
		setValue,
		handleSubmit,
		reset,
		formState: { errors },
	} = useForm<FormValues>({
		resolver: zodResolver(FormSchema),
	});

	const { isSuccess, isError, ...initiateConversationMutation } =
		useInitiateConversationMutation();

	const onSubmit = (data: FormValues) => {
		initiateConversationMutation.mutate({
			name: data.name ?? t`Participant`,
			pin: "",
			projectId: project.id,
			source: "PORTAL_AUDIO",
			tagIdList: data.tagIdList,
		});
	};

	useEffect(() => {
		if (isSuccess) {
			if (initiateConversationMutation.data?.id) {
				navigate(
					`/${project.id}/conversation/${initiateConversationMutation.data?.id}`,
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
	]);

	useEffect(() => {
		if (isError) {
			reset();
		}
	}, [isError, reset]);

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
