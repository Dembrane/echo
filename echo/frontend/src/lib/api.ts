import { toast } from "@/components/common/Toaster";
import { API_BASE_URL, USE_PARTICIPANT_ROUTER } from "@/config";
import axios, {
  AxiosError,
  AxiosRequestConfig,
  CreateAxiosDefaults,
} from "axios";
import { directus, directusContent, directusParticipant } from "./directus";
import { readItem, readItems, updateItem } from "@directus/sdk";
import { EchoPortalTutorial } from "./typesDirectusContent";

export const apiCommonConfig: CreateAxiosDefaults = {
  baseURL: API_BASE_URL,
  withCredentials: true,
};

export const apiNoAuth = axios.create(apiCommonConfig);

apiNoAuth.interceptors.response.use(
  (response) => response.data,
  (error) => {
    // Pass through errors
    throw error;
  },
);

export const api = axios.create(apiCommonConfig);

interface CustomAxiosRequestConfig extends AxiosRequestConfig {
  _retry?: boolean;
}

export const getParticipantProjectById = async (projectId: string) => {
  return directusParticipant.request<Project>(
    readItem("project", projectId, {
      fields: ["*", { tags: ["id", "project_id", "text"] }],
    }),
  );
};

export const getParticipantTutorialCardsBySlug = async (slug: string) => {
  return directusContent.request<EchoPortalTutorial[]>(
    readItems("echo__portal_tutorial", {
      filter: {
        slug: {
          _eq: slug,
        },
      },
      deep: {
        cards: {
          _sort: "sort",
        } as any,
      },
      fields: [
        "id",
        "slug",
        "count(cards)",
        {
          cards: [
            "id",
            "sort",
            {
              echo__portal_tutorial_card_id: [
                "id",
                "user_confirmation_required",
                "icon",
                "link",
                {
                  translations: ["*"],
                },
              ],
            },
          ],
        },
      ],
    }),
  );
};

export const getParticipantConversationChunks = async (
  projectId: string,
  conversationId: string,
) => {
  return apiNoAuth.get<unknown, TConversationChunk[]>(
    `participant/projects/${projectId}/conversations/${conversationId}/chunks`,
  );
};

export const deleteParticipantConversationChunk = async (
  projectId: string,
  conversationId: string,
  chunkId: string,
) => {
  return apiNoAuth.delete(
    `/participant/projects/${projectId}/conversations/${conversationId}/chunks/${chunkId}`,
  );
};

api.interceptors.response.use(
  (response) => response.data,
  async (error: AxiosError) => {
    const { config, response } = error;
    // Retry the request if the response status is 401 or 403
    if (
      response &&
      [401, 403].includes(response.status) &&
      config &&
      !(config as CustomAxiosRequestConfig)._retry
    ) {
      (config as CustomAxiosRequestConfig)._retry = true;
      try {
        if (!USE_PARTICIPANT_ROUTER) {
          // go to /login
          // window.location.assign("/login");
        }
        return api(config);
      } catch (e) {
        console.error("init session error", e);
        // Handle the error when refreshing the session fails
        throw e;
      }
    }
    // Pass through other errors
    throw error;
  },
);

export const getResourcesByProjectId = async (projectId: string) => {
  return api.get<unknown, TResource[]>(`/projects/${projectId}/resources`);
};

export const getResourceById = async (resourceId: string) => {
  return api.get<unknown, TResource>(`/resources/${resourceId}`);
};

export const updateResourceById = async (payload: {
  id: string;
  update: Partial<TResource>;
}) => {
  return api.put<unknown, TResource>(
    `/resources/${payload.id}`,
    payload.update,
  );
};

export const deleteResourceById = async (resourceId: string) => {
  return api.delete(`/resources/${resourceId}`);
};

export const uploadResourceByProjectId = async (payload: {
  projectId: string;
  files: File[];
}) => {
  const formData = new FormData();

  payload.files.forEach((file) => {
    formData.append("files", file);
  });

  return api.post<unknown, TResource[]>(
    `/projects/${payload.projectId}/resources/upload`,
    formData,
    {
      timeout: 60000,
      headers: {
        "Content-Type": "multipart/form-data",
      },
    },
  );
};

export const getLatestProjectAnalysisRunByProjectId = async (
  projectId: string,
) => {
  const data = await directus.request<ProjectAnalysisRun[]>(
    readItems("project_analysis_run", {
      filter: {
        project_id: projectId,
      },
      sort: "-created_at",
    }),
  );

  if (!data || data.length === 0) {
    return null;
  }

  return data[0];
};

export const getProjectViews = async (projectId: string) => {
  const project_analysis_run =
    await getLatestProjectAnalysisRunByProjectId(projectId);

  if (!project_analysis_run) {
    return [];
  }

  return directus.request<View[]>(
    readItems("view", {
      fields: [
        "*",
        { aspects: ["*", "count(quotes)", "quotes", "representative_quotes"] },
      ],
      deep: {
        aspects: {
          _sort: "-count(representative_quotes)",
        } as any,
      },
      filter: {
        project_analysis_run_id: project_analysis_run?.id,
      },
      sort: "-created_at",
    }),
  );
};

export const getProjectInsights = async (projectId: string) => {
  const project_analysis_run =
    await getLatestProjectAnalysisRunByProjectId(projectId);

  if (!project_analysis_run) {
    return [];
  }

  return directus.request<Insight[]>(
    readItems("insight", {
      fields: [
        "*",
        {
          quotes: [
            "id",
            "text",
            "timestamp",
            {
              conversation_id: ["id", "participant_name"],
            },
          ],
        },
        "count(quotes)",
      ],
      filter: {
        project_analysis_run_id: project_analysis_run?.id,
      },
      sort: "-created_at",
    }),
  );
};

export const getQuotesByConversationId = async (conversationId: string) => {
  const conversation = await directus.request<Conversation>(
    readItem("conversation", conversationId, {
      fields: ["project_id"],
    }),
  );

  if (!conversation) {
    return [];
  }

  const project_analysis_run = await getLatestProjectAnalysisRunByProjectId(
    conversation.project_id as string,
  );

  if (!project_analysis_run) {
    return [];
  }

  const data = await directus.request<Quote[]>(
    readItems("quote", {
      fields: [
        "*",
        {
          conversation_id: ["id", "participant_name"],
        },
      ],
      sort: "order",
      filter: {
        conversation_id: {
          _eq: conversationId,
        },
        project_analysis_run_id: project_analysis_run?.id,
      },
    }),
  );

  return data;
};

export const getProjectTranscriptsLink = (projectId: string) =>
  `${apiCommonConfig.baseURL}/projects/${projectId}/transcripts`;

export const initiateConversation = async (payload: {
  projectId: string;
  email?: string;
  name: string;
  pin: string;
  tagIdList: string[];
}) => {
  return apiNoAuth.post<unknown, TConversation>(
    `/participant/projects/${payload.projectId}/conversations/initiate`,
    {
      email: payload.email ?? undefined,
      name: payload.name,
      pin: payload.pin,
      tag_id_list: payload.tagIdList,
      user_agent: navigator.userAgent ?? undefined,
    },
  );
};

export const uploadConversationChunk = async (payload: {
  conversationId: string;
  chunk?: Blob;
  timestamp: Date;
}) => {
  const formData = new FormData();

  if (!payload.chunk) {
    throw new Error("No chunk provided");
  }

  const fileExtension = payload.chunk.type.split("/")[1].split(";")[0];
  const file = new File([payload.chunk], `chunk.${fileExtension}`, {
    type: payload.chunk.type,
  });
  formData.append("chunk", file);
  formData.append("timestamp", payload.timestamp.toISOString());

  return apiNoAuth.post<unknown, TConversationChunk[]>(
    `/participant/conversations/${payload.conversationId}/upload-chunk`,
    formData,
    {
      // 10 min
      timeout: 600000,
      // 25 mB
      maxBodyLength: 25 * 1024 * 1024,
      maxContentLength: 25 * 1024 * 1024,
      headers: {
        "Content-Type": "multipart/form-data",
      },
    },
  );
};

export const uploadConversationText = async (payload: {
  conversationId: string;
  content: string;
  timestamp: Date;
}) => {
  return apiNoAuth.post<unknown, TConversationChunk>(
    `/participant/conversations/${payload.conversationId}/upload-text`,
    {
      content: payload.content,
      timestamp: payload.timestamp.toISOString(),
    },
  );
};

export const initiateAndUploadConversationChunk = async (payload: {
  projectId: string;
  pin: string;
  namePrefix: string;
  tagIdList: string[];
  chunks: Blob[];
  timestamps: Date[];
  email?: string;
}) => {
  const promises = [];
  for (let i = 0; i < payload.chunks.length; i++) {
    try {
      toast(
        `Uploading conversation '${(payload.chunks[i] as unknown as any).name}'`,
      );
    } catch (e) {
      console.error(e);
    }

    let blob: Blob = payload.chunks[i];
    let name = "";

    if (payload.namePrefix) {
      name = `${payload.namePrefix}`;
    }

    if (blob instanceof File) {
      name += blob.name;

      const isxm4a = blob.type === "audio/x-m4a";
      if (isxm4a) {
        console.log("Converting xm4a to audio/m4a");
        blob = new Blob([await blob.arrayBuffer()], { type: "audio/m4a" });
      }
    } else {
      console.log("Blob is not a File");
      name += `chunk-${i}`;
    }

    const conversation = await initiateConversation({
      projectId: payload.projectId,
      email: payload.email,
      name: `${name}`,
      pin: payload.pin,
      tagIdList: payload.tagIdList,
    });

    promises.push(
      uploadConversationChunk({
        conversationId: conversation.id,
        chunk: blob,
        timestamp: payload.timestamps.at(i) ?? new Date(),
      }),
    );
  }

  return Promise.all(promises);
};

export const getConversationContentLink = (conversationId: string) =>
  `${apiCommonConfig.baseURL}/conversations/${conversationId}/content`;

export const getConversationChunkContentLink = (
  conversationId: string,
  chunkId: string,
  returnUrl: boolean = false,
) =>
  `${apiCommonConfig.baseURL}/conversations/${conversationId}/chunks/${chunkId}/content${returnUrl ? "?return_url=true" : ""}`;

export const generateProjectLibrary = async (payload: {
  projectId: string;
  language: string;
}) => {
  return api.post<unknown>(`/projects/${payload.projectId}/create-library`, {
    language: payload.language,
  });
};

export const generateProjectView = async (payload: {
  projectId: string;
  query: string;
  language: string;
  additionalContext?: string;
}) => {
  return api.post<unknown>(`/projects/${payload.projectId}/create-view`, {
    query: payload.query,
    additional_context: payload.additionalContext,
    language: payload.language,
  });
};

export const getConversationTranscriptString = async (
  conversationId: string,
) => {
  return api.get<unknown, string>(
    `/conversations/${conversationId}/transcript`,
  );
};

export const retranscribeConversation = async (
  conversationId: string,
  newConversationName: string,
) => {
  return api.post<
    unknown,
    { status: string; message: string; new_conversation_id: string }
  >(`/conversations/${conversationId}/retranscribe`, {
    new_conversation_name: newConversationName,
  });
};

export const getProjectChatContext = async (chatId: string) => {
  return api.get<unknown, TProjectChatContext>(`/chats/${chatId}/context`);
};

export const addChatContext = async (
  chatId: string,
  conversationId?: string,
) => {
  return api.post<unknown, TProjectChatContext>(
    `/chats/${chatId}/add-context`,
    {
      conversation_id: conversationId,
    },
  );
};

export const deleteChatContext = async (
  chatId: string,
  conversationId?: string,
) => {
  return api.post<unknown, TProjectChatContext>(
    `/chats/${chatId}/delete-context`,
    {
      conversation_id: conversationId,
    },
  );
};

// this will lock all unused conversations in the chat as a dembrane message
export const lockConversations = async (chatId: string) => {
  return api.post<unknown, TProjectChatContext>(
    `/chats/${chatId}/lock-conversations`,
  );
};

export const getChatHistory = async (chatId: string): Promise<ChatHistory> => {
  const data = await directus.request<ProjectChatMessage[]>(
    readItems("project_chat_message", {
      filter: {
        project_chat_id: chatId,
      },
      sort: "date_created",
      fields: [
        "*",
        {
          added_conversations: [
            {
              conversation_id: ["id", "participant_name"],
            },
          ],
        },
      ],
    }),
  );

  return data.map((message) => ({
    createdAt: message.date_created,
    id: message.id,
    role: message.message_from as "user" | "assistant",
    content: message.text ?? "",
    _original: message,
  }));
};

export const createProjectReport = async (payload: {
  projectId: string;
  language: string;
  otherPayload?: Partial<ProjectReport>;
}) => {
  const response = await api.post<unknown, ProjectReport>(
    `/projects/${payload.projectId}/create-report`,
    {
      language: payload.language,
    },
  );

  const reportId = response.id;

  if (payload.otherPayload) {
    await directus.request(
      updateItem("project_report", reportId, payload.otherPayload),
    );
  }

  return response;
};

export const finishConversation = async (conversationId: string) => {
  return apiNoAuth.post<unknown>(
    `/participant/conversations/${conversationId}/finish`,
  );
};
