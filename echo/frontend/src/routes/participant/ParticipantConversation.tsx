import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { I18nLink } from "@/components/common/i18nLink";
import { useProjectSharingLink } from "@/components/project/ProjectQRCode";
import {
  useUploadConversationChunk,
  useUploadConversationTextChunk,
} from "@/components/participant/hooks";
import {
  ActionIcon,
  Box,
  Button,
  Divider,
  Group,
  LoadingOverlay,
  Modal,
  Stack,
  Text,
} from "@mantine/core";
import {
  IconCheck,
  IconMicrophone,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlayerStopFilled,
  IconPlus,
  IconQuestionMark,
  IconReload,
  IconTextCaption,
  IconUpload,
} from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useDisclosure, useWindowEvent } from "@mantine/hooks";
import { useLanguage } from "@/hooks/useLanguage";
import { useWakeLock } from "@/hooks/useWakeLock";
import Cookies from "js-cookie";
import clsx from "clsx";

import { finishConversation } from "@/lib/api";
import {
  useConversationChunksQuery,
  useConversationQuery,
  useConversationRepliesQuery,
  useParticipantProjectById,
} from "@/components/participant/hooks";

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";

import { useChat } from "@ai-sdk/react";
import { toast, Toaster } from "@/components/common/Toaster";
import SpikeMessage from "../../components/participant/SpikeMessage";
import { ParticipantBody } from "../../components/participant/ParticipantBody";
import { checkPermissionError, scrollToBottom } from "@/lib/utils";
import { useElementOnScreen } from "@/hooks/useElementOnScreen";
import { ScrollToBottomButton } from "@/components/common/ScrollToBottom";
import { API_BASE_URL } from "@/config";
import useChunkedAudioRecorder from "@/components/participant/hooks/useChunkedAudioRecorder";
import { EchoErrorAlert } from "@/components/participant/EchoErrorAlert";

const DEFAULT_REPLY_COOLDOWN = 120; // 2 minutes in seconds

export const ParticipantConversationAudioRoute = () => {
  const { projectId, conversationId } = useParams();
  const [searchParams] = useSearchParams();

  // Get device ID from cookies for audio recording
  const savedDeviceId = Cookies.get("micDeviceId");
  const deviceId = savedDeviceId || "";

  const projectQuery = useParticipantProjectById(projectId ?? "");
  const conversationQuery = useConversationQuery(projectId, conversationId);
  const chunks = useConversationChunksQuery(projectId, conversationId);
  const repliesQuery = useConversationRepliesQuery(conversationId);
  const uploadChunkMutation = useUploadConversationChunk();

  const onChunk = (chunk: Blob) => {
    uploadChunkMutation.mutate({
      conversationId: conversationId ?? "",
      chunk,
      timestamp: new Date(),
      source: "PORTAL_AUDIO",
      runFinishHook: false,
    });
  };

  const [scrollTargetRef, isVisible] = useElementOnScreen({
    root: null,
    rootMargin: "-83px",
    threshold: 0.1,
  });

  const [troubleShootingGuideOpened, setTroubleShootingGuideOpened] =
    useState(false);
  const [lastReplyTime, setLastReplyTime] = useState<Date | null>(null);
  const [remainingCooldown, setRemainingCooldown] = useState(0);
  const [showCooldownMessage, setShowCooldownMessage] = useState(false);
  const [
    conversationDeletedDuringRecording,
    setConversationDeletedDuringRecording,
  ] = useState(false);

  const [isFinishing, setIsFinishing] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [opened, { open, close }] = useDisclosure(false);
  // Navigation and language
  const navigate = useI18nNavigate();
  const { iso639_1 } = useLanguage();
  const newConversationLink = useProjectSharingLink(projectQuery.data);

  // Calculate remaining cooldown time
  const getRemainingCooldown = useCallback(() => {
    if (!lastReplyTime) return 0;
    const cooldownSeconds = DEFAULT_REPLY_COOLDOWN;
    const elapsedSeconds = Math.floor(
      (new Date().getTime() - lastReplyTime.getTime()) / 1000,
    );
    return Math.max(0, cooldownSeconds - elapsedSeconds);
  }, [lastReplyTime]);

  // Update cooldown timer
  useEffect(() => {
    if (!lastReplyTime) return;

    const interval = setInterval(() => {
      const remaining = getRemainingCooldown();
      setRemainingCooldown(remaining);

      if (remaining <= 0) {
        clearInterval(interval);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [lastReplyTime, getRemainingCooldown]);

  const audioRecorder = useChunkedAudioRecorder({ onChunk, deviceId });
  useWakeLock({ obtainWakeLockOnMount: true });

  const {
    startRecording,
    stopRecording,
    isRecording,
    isPaused,
    pauseRecording,
    resumeRecording,
    recordingTime,
    errored,
    permissionError,
  } = audioRecorder;

  const handleMicrophoneDeviceChanged = async () => {
    stopRecording();
  };

  useWindowEvent("microphoneDeviceChanged", handleMicrophoneDeviceChanged);

  // Monitor conversation status during recording - handle deletion mid-recording
  useEffect(() => {
    if (isRecording && (conversationQuery.isError || !conversationQuery.data)) {
      console.warn(
        "Conversation deleted or became unavailable during recording",
      );
      stopRecording();
      setConversationDeletedDuringRecording(true);
    }
  }, [
    isRecording,
    conversationQuery.isError,
    conversationQuery.data,
    stopRecording,
  ]);

  const {
    messages: echoMessages,
    isLoading,
    status,
    error,
    reload,
    input,
    handleInputChange,
    handleSubmit,
  } = useChat({
    api: `${API_BASE_URL}/conversations/${conversationId}/get-reply`,
    initialMessages:
      repliesQuery.data?.map((msg) => ({
        id: String(msg.id),
        content: msg.content_text ?? "",
        role: msg.type === "assistant_reply" ? "assistant" : "user",
      })) ?? [],
    body: { language: iso639_1 },
    experimental_prepareRequestBody({ messages }) {
      const lastMessage = messages[messages.length - 1];
      return {
        language: iso639_1,
      };
    },
    onError: (error) => {
      console.error("onError", error);
    },
  });

  // Handlers
  const handleCheckMicrophoneAccess = async () => {
    const permissionError = await checkPermissionError();
    if (["granted", "prompt"].includes(permissionError ?? "")) {
      window.location.reload();
    } else {
      alert(
        t`Microphone access is still denied. Please check your settings and try again.`,
      );
    }
  };

  const handleReply = async (e: React.MouseEvent<HTMLButtonElement>) => {
    const remaining = getRemainingCooldown();
    if (remaining > 0) {
      setShowCooldownMessage(true);
      const minutes = Math.floor(remaining / 60);
      const seconds = remaining % 60;
      const timeStr =
        minutes > 0
          ? t`${minutes} minutes and ${seconds} seconds`
          : t`${seconds} seconds`;

      toast.info(t`Please wait ${timeStr} before requesting another Echo.`);
      return;
    }

    try {
      setShowCooldownMessage(false);
      // Wait for pending uploads to complete
      while (uploadChunkMutation.isPending) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      // scroll to bottom of the page
      setTimeout(() => {
        if (scrollTargetRef.current) {
          scrollTargetRef.current.scrollIntoView({ behavior: "smooth" });
        }
      }, 0);

      handleSubmit(e, { allowEmptySubmit: true });
      setLastReplyTime(new Date());
      setRemainingCooldown(DEFAULT_REPLY_COOLDOWN);
    } catch (error) {
      console.error("Error during echo:", error);
    }
  };

  const handleStopRecording = () => {
    if (isRecording) {
      pauseRecording();
      open();
    }
  };

  const handleConfirmFinish = async () => {
    setIsStopping(true);
    try {
      stopRecording();
      await finishConversation(conversationId ?? "");
      close();
      navigate(finishUrl);
    } catch (error) {
      console.error("Error finishing conversation:", error);
      toast.error(t`Failed to finish conversation. Please try again.`);
      setIsStopping(false);
    }
  };

  if (conversationQuery.isLoading || projectQuery.isLoading) {
    return <LoadingOverlay visible />;
  }

  // Check if conversation is not present or failed to load
  if (
    conversationQuery.isError ||
    !conversationQuery.data ||
    conversationDeletedDuringRecording
  ) {
    return (
      <div className="container mx-auto flex h-full max-w-2xl flex-col items-center justify-center">
        <div className="p-8 text-center">
          <Text size="xl" fw={500} c="red" mb="md">
            {conversationDeletedDuringRecording ? (
              <Trans id="participant.conversation.ended">
                Conversation Ended
              </Trans>
            ) : (
              <Trans id="participant.conversation.error">
                Something went wrong
              </Trans>
            )}
          </Text>
          <Text size="md" c="dimmed" mb="lg">
            {conversationDeletedDuringRecording ? (
              <Trans id="participant.conversation.error.deleted">
                It looks like the conversation was deleted while you were
                recording. We've stopped the recording to prevent any issues.
                You can start a new one anytime.
              </Trans>
            ) : (
              <Trans id="participant.conversation.error.loading">
                The conversation could not be loaded. Please try again or
                contact support.
              </Trans>
            )}
          </Text>
          <Group justify="center" gap="md">
            <Button
              variant="light"
              size="md"
              onClick={() => window.location.reload()}
              leftSection={<IconReload />}
            >
              <Trans id="participant.button.reload">Reload Page</Trans>
            </Button>
            {newConversationLink && (
              <Button
                leftSection={<IconPlus size={16} />}
                variant="filled"
                size="md"
                component="a"
                href={newConversationLink}
              >
                <Trans id="participant.button.start.new.conversation">
                  Start New Conversation
                </Trans>
              </Button>
            )}
          </Group>
        </div>
      </div>
    );
  }

  const textModeUrl = `/${projectId}/conversation/${conversationId}/text`;
  const finishUrl = `/${projectId}/conversation/${conversationId}/finish`;

  return (
    <div className="container mx-auto flex h-full max-w-2xl flex-col">
      {/* modal for permissions error */}
      <Modal
        opened={!!permissionError}
        onClose={() => true}
        centered
        fullScreen
        radius={0}
        transitionProps={{ transition: "fade", duration: 200 }}
        withCloseButton={false}
      >
        <div className="h-full rounded-md bg-white py-4">
          <Stack className="container mx-auto mt-4 max-w-2xl px-2" gap="lg">
            <div className="max-w-prose text-lg">
              <Trans id="participant.alert.microphone.access.failure">
                Oops! It looks like microphone access was denied. No worries,
                though! We've got a handy troubleshooting guide for you. Feel
                free to check it out. Once you've resolved the issue, come back
                and visit this page again to check if your microphone is ready.
              </Trans>
            </div>

            <Button
              component="a"
              href="https://dembrane.notion.site/Troubleshooting-Microphone-Permissions-All-Languages-bd340257647742cd9cd960f94c4223bb?pvs=74"
              target="_blank"
              size={troubleShootingGuideOpened ? "lg" : "xl"}
              leftSection={<IconQuestionMark />}
              variant={!troubleShootingGuideOpened ? "filled" : "light"}
              onClick={() => setTroubleShootingGuideOpened(true)}
            >
              <Trans id="participant.button.open.troubleshooting.guide">
                Open troubleshooting guide
              </Trans>
            </Button>
            <Divider />
            <Button
              size={!troubleShootingGuideOpened ? "lg" : "xl"}
              leftSection={<IconReload />}
              variant={troubleShootingGuideOpened ? "filled" : "light"}
              onClick={handleCheckMicrophoneAccess}
            >
              <Trans id="participant.button.check.microphone.access">
                Check microphone access
              </Trans>
            </Button>
          </Stack>
        </div>
      </Modal>

      {/* modal for stop recording confirmation */}
      <Modal
        opened={opened}
        onClose={isStopping ? () => {} : close}
        closeOnClickOutside={!isStopping}
        closeOnEscape={!isStopping}
        centered
        title={
          <Text fw={500}>
            <Trans id="participant.modal.stop.title">Finish Conversation</Trans>
          </Text>
        }
        size="sm"
        radius="md"
        padding="xl"
      >
        <Stack gap="lg">
          <Text>
            <Trans id="participant.modal.stop.message">
              Are you sure you want to finish the conversation?
            </Trans>
          </Text>
          <Group grow gap="md">
            <Button
              variant="outline"
              color="gray"
              onClick={close}
              disabled={isStopping}
              miw={100}
              radius="md"
              size="md"
            >
              <Trans id="participant.button.stop.no">No</Trans>
            </Button>
            <Button
              onClick={handleConfirmFinish}
              loading={isStopping}
              miw={100}
              radius="md"
              size="md"
            >
              <Trans id="participant.button.stop.yes">Yes</Trans>
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Box className={clsx("relative flex-grow p-4 pb-12 transition-all")}>
        {projectQuery.data && conversationQuery.data && (
          <ParticipantBody
            interleaveMessages={false}
            projectId={projectId ?? ""}
            conversationId={conversationId ?? ""}
            recordingStarted={isRecording}
          />
        )}

        <Stack gap="sm">
          {echoMessages && echoMessages.length > 0 && (
            <>
              {echoMessages.map((message, index) => (
                <SpikeMessage
                  key={message.id}
                  message={{
                    // @ts-expect-error - id is a string
                    id: parseInt(message.id) || 0,
                    content_text: message.content,
                    type:
                      message.role === "assistant" ? "assistant_reply" : "user",
                    date_created: new Date().toISOString(),
                  }}
                  loading={index === echoMessages.length - 1 && isLoading}
                  className={`min-h-[180px] md:min-h-[169px] ${index !== echoMessages.length - 1 ? "border-b" : ""}`}
                />
              ))}
              {status !== "streaming" && status !== "ready" && !error && (
                <SpikeMessage
                  key="thinking"
                  message={{
                    // @ts-expect-error - id is a string
                    id: 0,
                    content_text: t`Thinking...`,
                    type: "assistant_reply",
                    date_created: new Date().toISOString(),
                  }}
                  loading={true}
                  className="min-h-[180px] md:min-h-[169px]"
                />
              )}
            </>
          )}

          {error && <EchoErrorAlert error={error} />}
        </Stack>
        <div ref={scrollTargetRef} />
      </Box>

      {!errored && (
        <Stack
          gap="lg"
          className="sticky bottom-0 z-10 w-full border-t border-slate-300 bg-white p-4"
        >
          <Group
            justify="center"
            className={`absolute bottom-[125%] left-1/2 z-50 translate-x-[-50%]`}
          >
            <ScrollToBottomButton
              elementRef={scrollTargetRef}
              isVisible={isVisible}
            />
          </Group>

          {/* Recording time indicator */}
          {isRecording && (
            <div className="w-full border-slate-300 bg-white pb-4 pt-2">
              <Group justify="center" align="center">
                {isPaused ? (
                  <IconPlayerPause />
                ) : (
                  <div className="h-4 w-4 animate-pulse rounded-full bg-red-500"></div>
                )}
                <Text className="text-3xl">
                  {Math.floor(recordingTime / 3600) > 0 && (
                    <>
                      {Math.floor(recordingTime / 3600)
                        .toString()
                        .padStart(2, "0")}
                      :
                    </>
                  )}
                  {Math.floor((recordingTime % 3600) / 60)
                    .toString()
                    .padStart(2, "0")}
                  :{(recordingTime % 60).toString().padStart(2, "0")}
                </Text>
              </Group>
            </div>
          )}

          <Group justify="center">
            {!isRecording && (
              <>
                <Group className="w-full">
                  {chunks?.data &&
                    chunks.data.length > 0 &&
                    !!projectQuery.data?.is_get_reply_enabled && (
                      <Group>
                        <Button
                          fullWidth
                          variant="default"
                          size="lg"
                          radius="md"
                          onClick={(e) => {
                            handleReply(e);
                          }}
                          loading={isLoading}
                          loaderProps={{ type: "dots" }}
                        >
                          {showCooldownMessage && remainingCooldown > 0 ? (
                            <Text>
                              <Trans>
                                <span className="hidden md:inline">Wait </span>
                                {Math.floor(remainingCooldown / 60)}:
                                {(remainingCooldown % 60)
                                  .toString()
                                  .padStart(2, "0")}
                              </Trans>
                            </Text>
                          ) : (
                            <Trans id="participant.button.echo">ECHO</Trans>
                          )}
                        </Button>
                      </Group>
                    )}

                  <Button
                    size="lg"
                    radius="md"
                    rightSection={<IconMicrophone />}
                    onClick={startRecording}
                    className="flex-grow"
                  >
                    <Trans id="participant.button.record">Record</Trans>
                  </Button>

                  <I18nLink to={textModeUrl}>
                    <ActionIcon
                      component="a"
                      size="50"
                      variant="default"
                      radius="md"
                    >
                      <IconTextCaption />
                    </ActionIcon>
                  </I18nLink>

                  {!isRecording &&
                    !isStopping &&
                    chunks?.data &&
                    chunks.data.length > 0 && (
                      <Button
                        size="lg"
                        radius="md"
                        onClick={open}
                        variant="light"
                        rightSection={<IconCheck />}
                        className="w-full md:w-auto"
                        loading={isFinishing}
                        disabled={isFinishing}
                      >
                        <Trans id="participant.button.finish">Finish</Trans>
                      </Button>
                    )}
                </Group>
              </>
            )}

            {isRecording && (
              <>
                {chunks?.data &&
                  chunks.data.length > 0 &&
                  !!projectQuery.data?.is_get_reply_enabled && (
                    <Group>
                      <Button
                        fullWidth
                        variant="default"
                        size="lg"
                        radius="md"
                        onClick={(e) => {
                          handleReply(e);
                        }}
                        loading={isLoading}
                        loaderProps={{ type: "dots" }}
                      >
                        {showCooldownMessage && remainingCooldown > 0 ? (
                          <Text>
                            <Trans>
                              <span className="hidden md:inline">Wait </span>
                              {Math.floor(remainingCooldown / 60)}:
                              {(remainingCooldown % 60)
                                .toString()
                                .padStart(2, "0")}
                            </Trans>
                          </Text>
                        ) : (
                          <Trans id="participant.button.is.recording.echo">
                            ECHO
                          </Trans>
                        )}
                      </Button>
                    </Group>
                  )}

                {isPaused ? (
                  <Button
                    className="flex-1"
                    size="lg"
                    radius="md"
                    onClick={resumeRecording}
                  >
                    <span className="hidden md:block">
                      <Trans id="participant.button.resume">Resume</Trans>
                    </span>
                    <IconPlayerPlay size={18} className="ml-0 md:ml-1" />
                  </Button>
                ) : (
                  <Button
                    className="flex-1"
                    size="lg"
                    radius="md"
                    onClick={pauseRecording}
                  >
                    <span className="hidden md:block">
                      <Trans id="participant.button.pause">Pause</Trans>
                    </span>
                    <IconPlayerPause size={18} className="ml-0 md:ml-1" />
                  </Button>
                )}

                <Button
                  variant="outline"
                  size="lg"
                  radius="md"
                  color="red"
                  onClick={handleStopRecording}
                  disabled={isStopping}
                  className={
                    !chunks?.data ||
                    chunks.data.length === 0 ||
                    !projectQuery.data?.is_get_reply_enabled
                      ? "flex-1"
                      : ""
                  }
                >
                  <Trans id="participant.button.stop">Stop</Trans>
                  <IconPlayerStopFilled
                    size={18}
                    className="ml-0 hidden md:ml-1 md:block"
                  />
                </Button>
              </>
            )}
          </Group>
        </Stack>
      )}
    </div>
  );
};

export const ParticipantConversationTextRoute = () => {
  const { projectId, conversationId } = useParams();
  const projectQuery = useParticipantProjectById(projectId ?? "");
  const conversationQuery = useConversationQuery(projectId, conversationId);
  const chunks = useConversationChunksQuery(projectId, conversationId);
  const uploadChunkMutation = useUploadConversationTextChunk();
  const newConversationLink = useProjectSharingLink(projectQuery.data);

  const [text, setText] = useState("");
  const [
    finishModalOpened,
    { open: openFinishModal, close: closeFinishModal },
  ] = useDisclosure(false);

  const [scrollTargetRef, isVisible] = useElementOnScreen({
    root: null,
    rootMargin: "-158px",
    threshold: 0.1,
  });

  const onChunk = () => {
    if (!text || text.trim() === "") {
      return;
    }

    setTimeout(() => {
      if (scrollTargetRef.current) {
        scrollTargetRef.current.scrollIntoView({ behavior: "smooth" });
      }
    }, 0);

    uploadChunkMutation.mutate({
      conversationId: conversationId ?? "",
      timestamp: new Date(),
      content: text.trim(),
      source: "PORTAL_TEXT",
    });

    setText("");
  };

  const navigate = useI18nNavigate();

  const audioModeUrl = `/${projectId}/conversation/${conversationId}`;
  const finishUrl = `/${projectId}/conversation/${conversationId}/finish`;

  const handleConfirmFinishButton = () => {
    navigate(finishUrl);
  };

  if (conversationQuery.isLoading || projectQuery.isLoading) {
    return <LoadingOverlay visible />;
  }

  // Check if conversation is not present or failed to load
  if (conversationQuery.isError || !conversationQuery.data) {
    return (
      <div className="container mx-auto flex h-full max-w-2xl flex-col items-center justify-center">
        <div className="p-8 text-center">
          <Text size="xl" fw={500} c="red" mb="md">
            <Trans id="participant.conversation.error.text.mode">
              Something went wrong
            </Trans>
          </Text>
          <Text size="md" c="dimmed" mb="lg">
            <Trans id="participant.conversation.error.loading.text.mode">
              The conversation could not be loaded. Please try again or contact
              support.
            </Trans>
          </Text>
          <Group justify="center" gap="md">
            <Button
              variant="light"
              size="md"
              onClick={() => window.location.reload()}
              leftSection={<IconReload />}
            >
              <Trans id="participant.button.reload.page.text.mode">
                Reload Page
              </Trans>
            </Button>
            {newConversationLink && (
              <Button
                leftSection={<IconPlus size={16} />}
                variant="filled"
                size="md"
                component="a"
                href={newConversationLink}
              >
                <Trans id="participant.button.start.new.conversation.text.mode">
                  Start New Conversation
                </Trans>
              </Button>
            )}
          </Group>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto flex h-full max-w-2xl flex-col">
      {/* modal for finish conversation confirmation */}
      <Modal
        opened={finishModalOpened}
        onClose={closeFinishModal}
        centered
        title={
          <Text fw={500}>
            <Trans id="participant.modal.finish.title.text.mode">
              Finish Conversation
            </Trans>
          </Text>
        }
        size="sm"
        radius="md"
        padding="xl"
      >
        <Stack gap="lg">
          <Text>
            <Trans id="participant.modal.finish.message.text.mode">
              Are you sure you want to finish the conversation?
            </Trans>
          </Text>
          <Group grow gap="md">
            <Button
              variant="outline"
              color="gray"
              onClick={closeFinishModal}
              miw={100}
              radius="md"
              size="md"
            >
              <Trans id="participant.button.finish.no.text.mode">No</Trans>
            </Button>
            <Button
              onClick={handleConfirmFinishButton}
              miw={100}
              radius="md"
              size="md"
            >
              <Trans id="participant.button.finish.yes.text.mode">Yes</Trans>
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Box className={clsx("relative flex-grow px-4 py-12 transition-all")}>
        {projectQuery.data && conversationQuery.data && (
          <ParticipantBody
            viewResponses
            projectId={projectId ?? ""}
            conversationId={conversationId ?? ""}
          />
        )}

        <div ref={scrollTargetRef} className="h-0" />
      </Box>

      <Stack className="sticky bottom-0 z-10 w-full border-slate-300 bg-white p-4">
        <Group
          justify="center"
          className={`absolute bottom-[110%] left-1/2 z-50 translate-x-[-50%]`}
        >
          {/* <ScrollToBottomButton
            elementRef={scrollTargetRef}
            isVisible={isVisible}
          /> */}
        </Group>
        <textarea
          className="h-32 w-full rounded-md border border-slate-300 p-4"
          placeholder={t`Type your response here`}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Group className="w-full">
          <Button
            size="lg"
            radius="md"
            rightSection={<IconUpload />}
            onClick={onChunk}
            loading={uploadChunkMutation.isPending}
            className="flex-grow"
          >
            <Trans id="participant.button.submit.text.mode">Submit</Trans>
          </Button>

          <I18nLink to={audioModeUrl}>
            <ActionIcon component="a" variant="default" size="50" radius="md">
              <IconMicrophone />
            </ActionIcon>
          </I18nLink>
          {text.trim() == "" && chunks.data && chunks.data.length > 0 && (
            <Button
              size="lg"
              radius="md"
              onClick={openFinishModal}
              component="a"
              variant="light"
              rightSection={<IconCheck />}
            >
              <Trans id="participant.button.finish.text.mode">Finish</Trans>
            </Button>
          )}
        </Group>
      </Stack>
    </div>
  );
};
