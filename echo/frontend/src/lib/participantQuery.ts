import { useQuery } from "@tanstack/react-query";
import {
  getParticipantConversationChunks,
  getParticipantProjectById,
  getParticipantTutorialCardsBySlug,
} from "./api";
import { directus } from "./directus";
import { readItem, readItems } from "@directus/sdk";

export const useParticipantProjectById = (projectId: string) => {
  return useQuery({
    queryKey: ["participantProject", projectId],
    queryFn: () => getParticipantProjectById(projectId),
  });
};

export const useParticipantTutorialCardBySlug = (slug: string) => {
  return useQuery({
    queryKey: ["participantTutorialCard", slug],
    queryFn: () => getParticipantTutorialCardsBySlug(slug),
    select: (data) => (data.length > 0 ? data[0] : null),
    enabled: slug !== "",
  });
};

export const combineUserChunks = (
  chunks: { type: "user_chunk"; timestamp: Date; data: TConversationChunk }[],
) => {
  return {
    type: "user_chunk" as const,
    timestamp: chunks[0].timestamp,
    data: {
      ...chunks[0].data,
      transcript: chunks.map((c) => c.data.transcript).join("..."),
    },
  };
};

export const useConversationRepliesQuery = (conversationId: string | undefined) => {
  return useQuery({
    queryKey: ["participant", "conversation_replies", conversationId],
    queryFn: () =>
      directus.request(
        readItems("conversation_reply", {
          filter: { conversation_id: { _eq: conversationId } },
          fields: ["id", "content_text", "date_created", "type"],
          sort: ["date_created"],
        }),
      ),
    enabled: !!conversationId,
    // refetchInterval: 15000,
  });
};

export const useConversationQuery = (
  projectId: string | undefined,
  conversationId: string | undefined,
) => {
  return useQuery({
    queryKey: ["participant", "conversation", projectId, conversationId],
    queryFn: () =>
      directus.request(readItem("conversation", conversationId ?? "")),
    enabled: !!conversationId,
    refetchInterval: 30000,
  });
};

export const useConversationChunksQuery = (
  projectId: string | undefined,
  conversationId: string | undefined,
) => {
  return useQuery({
    queryKey: ["participant", "conversation_chunks", conversationId],
    queryFn: () =>
      getParticipantConversationChunks(projectId ?? "", conversationId ?? ""),
    enabled: !!conversationId,
    refetchInterval: 15000,
  });
};