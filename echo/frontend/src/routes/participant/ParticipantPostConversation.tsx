import { useState, KeyboardEvent, useRef } from "react";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { I18nLink } from "@/components/common/i18nLink";
import { Markdown } from "@/components/common/Markdown";
import { useParticipantProjectById } from "@/lib/participantQuery";
import {
  Box,
  Button,
  Divider,
  LoadingOverlay,
  Stack,
  Text,
  TextInput,
  Title,
  Chip,
  Group,
  Tooltip,
  Paper,
} from "@mantine/core";
import {
  IconArrowRight,
  IconCheck,
  IconLoader2,
  IconMail,
} from "@tabler/icons-react";
import { useParams } from "react-router-dom";

import { useMutation } from "@tanstack/react-query";
import { directus } from "@/lib/directus";
import { readItems, createItems } from "@directus/sdk";
import {
  useCheckProjectNotificationParticipants,
  useSubmitNotification,
} from "@/lib/query";

export const ParticipantPostConversation = () => {
  const { projectId, conversationId } = useParams();
  const project = useParticipantProjectById(projectId ?? "");
  const [emails, setEmails] = useState<string[]>([]);
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [isCheckingEmail, setIsCheckingEmail] = useState(false);
  const [debounceTimeout, setDebounceTimeout] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { mutate: checkEmail, isPending: isCheckingParticipantEmail } =
    useCheckProjectNotificationParticipants();
  const { mutate, isPending } = useSubmitNotification();

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
      { emails, projectId },
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

    // Clear the previous timeout
    if (debounceTimeout) clearTimeout(debounceTimeout);

    // Set a new timeout to validate after 500ms
    const newTimeout = window.setTimeout(() => {
      if (!validateEmail(newEmail) && newEmail.trim() !== "") {
        setError(t`Please enter a valid email.`);
      } else {
        setError("");
      }
    }, 300);

    setDebounceTimeout(newTimeout);
  };

  const addEmail = async (inputElement?: HTMLInputElement | null) => {
    const trimmedEmail = email.trim();
    if (!trimmedEmail) return;

    if (emails.includes(trimmedEmail)) {
      setError(t`This email is already in the list.`);
      return;
    }
    if (!validateEmail(trimmedEmail)) {
      setError(t`Please enter a valid email.`);
      return;
    }

    setIsCheckingEmail(true);
    setError("");

    try {
      checkEmail(
        { email: trimmedEmail, projectId: projectId ?? "" },
        {
          onSuccess: (data) => {
            switch (data.status) {
              case "subscribed":
                setError(t`This email is already subscribed to notifications.`);
                break;
              case "opted_out":
              case "new":
                setEmails([...emails, trimmedEmail]);
                setEmail("");
                break;
            }
          },
          onError: (_error) => {
            setError(t`Failed to verify email status. Please try again.`);
          },
        },
      );
    } catch (error) {
      setError(t`Failed to verify email status. Please try again.`);
    } finally {
      setIsCheckingEmail(false);
      setTimeout(() => inputElement?.focus(), 100);
    }
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
    <div className="container mx-auto h-full max-w-2xl">
      <Stack className="mt-[64px] px-4 py-8">
        {!!text && text != "" ? (
          <>
            <Markdown content={text} />
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
            <Button component="a" size="md" variant="outline">
              <Trans>Record another conversation</Trans>
            </Button>
          </I18nLink>
          {project.data?.is_project_notification_subscription_allowed && (
            <Stack className="mt-20 md:mt-32">
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
                      disabled={
                        isCheckingEmail ||
                        isPending ||
                        isCheckingParticipantEmail
                      }
                      rightSection={
                        <Button
                          size="sm"
                          variant="light"
                          onClick={() => addEmail(inputRef.current)}
                          disabled={
                            !email.trim() ||
                            isCheckingEmail ||
                            isPending ||
                            isCheckingParticipantEmail
                          }
                          className="me-[2px] hover:bg-blue-50"
                          loading={
                            isCheckingEmail || isCheckingParticipantEmail
                          }
                        >
                          {isCheckingEmail ? t`Checking...` : t`Add`}
                        </Button>
                      }
                      rightSectionWidth="auto"
                    />
                    {emails.length > 0 && (
                      <Paper shadow="sm" radius="sm" p="md" withBorder>
                        <Text size="sm" fw={500} className="mb-2">
                          <Trans>Added emails</Trans> ({emails.length}):
                        </Text>
                        <Group>
                          {emails.map((email, index) => (
                            <Tooltip
                              key={index}
                              label={t`Remove Email`}
                              transitionProps={{
                                transition: "pop",
                                duration: 100,
                              }}
                              refProp="rootRef"
                            >
                              <Chip
                                disabled={
                                  isPending || isCheckingParticipantEmail
                                }
                                value={email}
                                variant="outline"
                                onClick={() => removeEmail(email)}
                                styles={{
                                  iconWrapper: { display: "none" },
                                }}
                              >
                                {email}
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
                        disabled={isCheckingParticipantEmail}
                        className="mt-4"
                      >
                        {isPending ? (
                          <IconLoader2 className="animate-spin" />
                        ) : (
                          <>
                            <Trans> Submit</Trans>
                          </>
                        )}
                      </Button>
                    )}
                  </Stack>
                </>
              ) : (
                <Box p="md">
                  <Text
                    c="green"
                    size="md"
                    className="flex items-center gap-4 md:gap-2"
                  >
                    <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-green-500 text-white">
                      <IconCheck size={16} strokeWidth={3} />
                    </span>
                    <Trans>
                      Thank you! We'll notify you when the report is ready.
                    </Trans>
                  </Text>
                </Box>
              )}
              <Text size="sm" c="gray.6" className="mt-4">
                <Trans>
                  We will only send you a message if your host generates a
                  report, we never share your details with anyone. You can opt
                  out at any time.
                </Trans>
              </Text>
            </Stack>
          )}
        </Box>
      </Stack>
    </div>
  );
};
