import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Box,
	Button,
	Chip,
	Divider,
	Group,
	LoadingOverlay,
	Paper,
	Stack,
	Text,
	TextInput,
	Title,
	Tooltip,
} from "@mantine/core";
import { IconCheck, IconLoader2, IconMail } from "@tabler/icons-react";
import { type KeyboardEvent, useRef, useState } from "react";
import { useParams } from "react-router";
import { I18nLink } from "@/components/common/i18nLink";
import { Markdown } from "@/components/common/Markdown";
import {
	useParticipantProjectById,
	useSubmitNotificationParticipant,
} from "@/components/participant/hooks";
import { testId } from "@/lib/testUtils";

export const ParticipantPostConversation = () => {
	const { projectId, conversationId } = useParams();
	const project = useParticipantProjectById(projectId ?? "");
	const [emails, setEmails] = useState<string[]>([]);
	const [email, setEmail] = useState("");
	const [error, setError] = useState("");
	const [isSubmitted, setIsSubmitted] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const { mutate, isPending } = useSubmitNotificationParticipant();

	const initiateLink = `/${projectId}/start`;

	const variables = {
		"{{CONVERSATION_ID}}": conversationId ?? "null",
		"{{PROJECT_ID}}": projectId ?? "null",
	};

	const text =
		project.data?.default_conversation_finish_text?.replace(
			/{{CONVERSATION_ID}}|{{PROJECT_ID}}/g,
			// @ts-expect-error variables is not typed
			(match) => variables[match],
		) ?? null;

	const handleSubscribe = () => {
		if (!projectId) return;

		mutate(
			{ conversationId: conversationId ?? "", emails, projectId },
			{
				onSuccess: () => setIsSubmitted(true),
			},
		);
	};

	const validateEmail = (email: string) => {
		const emailRegex =
			/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}$/;
		return emailRegex.test(email);
	};

	const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const newEmail = e.target.value;
		setEmail(newEmail);
		// Clear error while typing - validate only on add/submit
		if (error) setError("");
	};

	const addEmail = (inputElement?: HTMLInputElement | null) => {
		const trimmedEmail = email.trim().toLowerCase();
		if (!trimmedEmail) return;

		if (emails.includes(trimmedEmail)) {
			setError(t`This email is already in the list.`);
			return;
		}
		if (!validateEmail(trimmedEmail)) {
			setError(t`Please enter a valid email.`);
			return;
		}

		setEmails([...emails, trimmedEmail]);
		setEmail("");
		setError("");
		setTimeout(() => inputElement?.focus(), 100);
	};

	const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter") {
			e.preventDefault();
			addEmail(e.target as HTMLInputElement);
		}
	};

	const removeEmail = (email: string) => {
		setEmails(emails.filter((e) => e !== email));
	};

	return (
		<div
			className="container mx-auto max-w-2xl"
			{...testId("portal-finish-container")}
		>
			<Stack className="mt-[64px] px-4 py-8">
				{!!text && text !== "" ? (
					<>
						<div {...testId("portal-finish-custom-message")}>
							<Markdown content={text} />
						</div>
						<Divider />
					</>
				) : (
					<Title order={2}>
						<Trans>Thank you for participating!</Trans>
					</Title>
				)}
				<Text size="lg">
					<Trans>
						Your response has been recorded. You may now close this tab.
					</Trans>{" "}
					<Trans>You may also choose to record another conversation.</Trans>
				</Text>
				<Box className="relative">
					<LoadingOverlay visible={project.isLoading} />
					<I18nLink to={initiateLink}>
						<Button
							component="a"
							size="md"
							variant="outline"
							{...testId("portal-finish-record-another-button")}
						>
							<Trans>Record another conversation</Trans>
						</Button>
					</I18nLink>
				{project.data?.default_conversation_ask_for_participant_email && (
					<Stack
						className="mt-20 md:mt-32"
						{...testId("portal-finish-notification-section")}
					>
						{!isSubmitted ? (
							<>
								<Stack gap="xs">
									<Text size="lg" fw={700}>
										<Trans>Do you want to stay in the loop?</Trans>
									</Text>
									<Text size="sm" c="gray.6">
										<Trans>Share your details here</Trans>
									</Text>
								</Stack>
								<Stack gap="md">
									<TextInput
										ref={inputRef}
										placeholder={t`email@work.com`}
										value={email}
										size="md"
										leftSection={<IconMail size={20} />}
										onChange={handleInputChange}
										onKeyDown={handleKeyDown}
										error={error}
										disabled={isPending}
										rightSection={
											<Button
												size="sm"
												variant="outline"
												onClick={() => addEmail(inputRef.current)}
												disabled={!email.trim() || isPending}
												className="me-[2px] hover:bg-blue-50"
												{...testId("portal-finish-email-add-button")}
											>
												{t`Add`}
											</Button>
										}
										rightSectionWidth="auto"
										{...testId("portal-finish-email-input")}
									/>
									{emails.length > 0 && (
										<Paper
											shadow="sm"
											radius="sm"
											p="md"
											withBorder
											{...testId("portal-finish-email-list")}
										>
											<Text size="sm" fw={500} className="mb-2">
												<Trans>Added emails</Trans> ({emails.length}):
											</Text>
											<Group>
												{emails.map((emailItem, index) => (
													<Tooltip
														key={`${emailItem}`}
														label={t`Remove Email`}
														transitionProps={{
															duration: 100,
															transition: "pop",
														}}
														refProp="rootRef"
													>
														<Chip
															disabled={isPending}
															value={emailItem}
															variant="outline"
															onClick={() => removeEmail(emailItem)}
															styles={{
																iconWrapper: { display: "none" },
															}}
															{...testId(`portal-finish-email-chip-${index}`)}
														>
															{emailItem}
														</Chip>
													</Tooltip>
												))}
											</Group>
										</Paper>
									)}
									{emails.length > 0 && (
										<Button
											size="lg"
											fullWidth
											onClick={handleSubscribe}
											loading={isPending}
											className="mt-4"
											{...testId("portal-finish-email-submit-button")}
										>
											{isPending ? (
												<IconLoader2 className="animate-spin" />
											) : (
												<Trans> Submit</Trans>
											)}
										</Button>
									)}
								</Stack>
							</>
						) : (
							<Box p="md" {...testId("portal-finish-email-success")}>
								<Text
									c="green"
									size="md"
									className="flex items-center gap-4 md:gap-2"
								>
									<span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-green-500 text-white">
										<IconCheck size={16} strokeWidth={3} />
									</span>
									<Trans>
										Thank you!
									</Trans>
								</Text>
							</Box>
						)}
						{project.data?.is_project_notification_subscription_allowed && (
							<Text
								size="sm"
								c="gray.6"
								className="mt-4"
								{...testId("portal-finish-email-disclaimer")}
							>
								<Trans>
									We will only send you a message if your host generates a
									report, we never share your details with anyone. You can opt
									out at any time.
								</Trans>
							</Text>
						)}
					</Stack>
				)}
				</Box>
			</Stack>
		</div>
	);
};
