import WelcomeImage from "@/assets/participant-welcome-pattern.png";
import {
  combineUserChunks,
  useConversationChunksQuery,
  useConversationRepliesQuery,
  useParticipantProjectById,
} from "@/lib/participantQuery";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { PropsWithChildren, useEffect, useMemo, useRef } from "react";

import { useDisclosure } from "@mantine/hooks";
import { Button, Modal, Stack, Title } from "@mantine/core";
import { Toaster } from "@/components/common/Toaster";
import { Trans } from "@lingui/react/macro";
import SystemMessage from "./SystemMessage";
import { t } from "@lingui/core/macro";
import UserChunkMessage from "./UserChunkMessage";
import SpikeMessage from "./SpikeMessage";

export const ParticipantBody = ({
  projectId,
  conversationId,
  viewResponses = false,
  children,
  interleaveMessages = true,
}: PropsWithChildren<{
  projectId: string;
  conversationId: string;
  viewResponses?: boolean;
  interleaveMessages?: boolean;
}>) => {
  const [ref] = useAutoAnimate();
  const [chatRef] = useAutoAnimate();
  const bottomRef = useRef<HTMLDivElement>(null);

  const projectQuery = useParticipantProjectById(projectId);
  const chunksQuery = useConversationChunksQuery(projectId, conversationId);
  const repliesQuery = useConversationRepliesQuery(conversationId);

  const combinedMessages = useMemo(() => {
    const userChunks = (chunksQuery.data ?? []).map((chunk) => ({
      type: "user_chunk" as const,
      timestamp: new Date(chunk.timestamp),
      data: chunk,
    }));

    const replies = (repliesQuery.data ?? [])
      .filter((m) => ["assistant_reply"].includes(m.type ?? ""))
      .map((m) => ({
        type: "assistant_chunk" as const,
        timestamp: new Date(m.date_created ?? ""),
        data: m,
      }));

    const allMessages = [...userChunks, ...replies].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );

    const combinedResult = [];
    let currentUserChunks = [];

    for (let i = 0; i < allMessages.length; i++) {
      const message = allMessages[i];
      if (message.type === "user_chunk") {
        currentUserChunks.push(message);
      } else {
        if (currentUserChunks.length > 0) {
          if (currentUserChunks.length > 1) {
            combinedResult.push(combineUserChunks(currentUserChunks));
          } else {
            combinedResult.push(currentUserChunks[0]);
          }
          currentUserChunks = [];
        }
        combinedResult.push(message);
      }
    }
    if (currentUserChunks.length > 0) {
      if (currentUserChunks.length > 1) {
        combinedResult.push(combineUserChunks(currentUserChunks));
      } else {
        combinedResult.push(currentUserChunks[0]);
      }
    }

    return combinedResult;
  }, [chunksQuery.data, repliesQuery.data, interleaveMessages]);

  const [opened, { open, close }] = useDisclosure(false);

  useEffect(() => {
    if (interleaveMessages && bottomRef.current) {
      bottomRef.current.scrollIntoView();
    }
  }, []);

  return (
    <Stack ref={ref} className="max-h-full">
      <Toaster position="top-center" richColors />
      <h2 className="text-center text-3xl">
        <Trans>Welcome</Trans>
      </h2>
      <img
        className="w-full animate-pulse object-contain duration-1000"
        src={WelcomeImage}
      />
      {projectQuery.data && (
        <Stack ref={chatRef} py="md" pb={9}>
          <Title order={3}>
            {projectQuery.data.default_conversation_title}
          </Title>

          {projectQuery.data.default_conversation_description && (
            <SystemMessage
              markdown={
                projectQuery.data.default_conversation_description ?? ""
              }
            />
          )}

          <SystemMessage
            markdown={t`Please record your response by clicking the "Record" button below. You may also choose to respond in text by clicking the text icon.`}
            className="mb-4"
          />

          {children}

          {interleaveMessages ? (
            <Stack gap="sm">
              {combinedMessages.map((message, index) => (
                <div key={index}>
                  {message.type === "user_chunk" ? (
                    <UserChunkMessage chunk={message.data} />
                  ) : (
                    <SpikeMessage
                      message={message.data}
                      className={
                        index !== combinedMessages.length - 1 ? "border-b" : ""
                      }
                    />
                  )}
                </div>
              ))}
            </Stack>
          ) : (
            <>
              {viewResponses ? (
                <div className="flex justify-end">
                  <Stack gap="sm">
                    {chunksQuery.data
                      ?.sort(
                        (a, b) =>
                          new Date(a.timestamp).getTime() -
                          new Date(b.timestamp).getTime(),
                      )
                      .map((chunk) => (
                        <UserChunkMessage key={chunk.id} chunk={chunk} />
                      ))}
                  </Stack>
                </div>
              ) : (
                <>
                  {chunksQuery.data && chunksQuery.data.length > 0 && (
                    <div className="flex justify-end">
                      <Button variant="transparent" onClick={open}>
                        <Trans>View your responses</Trans>
                      </Button>
                    </div>
                  )}
                  <Modal
                    opened={opened}
                    onClose={close}
                    size="lg"
                    padding="xl"
                    radius="md"
                    title={t`Your responses`}
                  >
                    <div>
                      <Stack gap="sm">
                        {chunksQuery.data
                          ?.sort(
                            (a, b) =>
                              new Date(a.timestamp).getTime() -
                              new Date(b.timestamp).getTime(),
                          )
                          .map((chunk) => (
                            <UserChunkMessage key={chunk.id} chunk={chunk} />
                          ))}
                      </Stack>
                    </div>
                  </Modal>
                </>
              )}
            </>
          )}

          <div ref={bottomRef} className={viewResponses ? "" : "hidden"}></div>
        </Stack>
      )}
    </Stack>
  );
};
