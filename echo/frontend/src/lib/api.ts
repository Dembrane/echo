// @FIXME: this file must be decomposed into @/components/xxx/api/index.ts
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
  return apiNoAuth.get<unknown, Project>(
    `/participant/projects/${projectId}`,
  );
};

export const getParticipantConversationById = async (projectId: string, conversationId: string) => {
  return apiNoAuth.get<unknown, Conversation>(
    `/participant/projects/${projectId}/conversations/${conversationId}`,
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
        { aspects: ["*", "count(aspect_segment)", "aspect_segment"] },
      ],
      filter: {
        project_analysis_run_id: project_analysis_run?.id,
      },
      sort: "-created_at",
    }),
  );
};

export const getProjectTranscriptsLink = (projectId: string) =>
  `${apiCommonConfig.baseURL}/projects/${projectId}/transcripts`;

export const initiateConversation = async (payload: {
  projectId: string;
  email?: string;
  name: string;
  pin: string;
  source: string;
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
      source: payload.source,
    },
  );
};

/**
 * Helper to get file extension from MIME type
 * 
 * IMPORTANT BROWSER EDGE CASES:
 * 
 * 1. Safari < 18.4 does NOT support Opus/Vorbis in Ogg containers
 *    - Opus only works in CAF files on macOS High Sierra (10.13) or iOS 11+
 *    - Vorbis/Opus in Ogg was added in Safari 18.4+
 * 
 * 2. Chrome limitations:
 *    - AAC only works in MP4 containers, not ADTS
 *    - Only supports AAC Main Profile
 *    - Chromium builds have NO AAC support at all
 * 
 * 3. Firefox quirks:
 *    - AAC support depends on OS media framework
 *    - Ogg Opus files > 12h 35m get truncated on Linux 64-bit
 *    - Prior to v71, MP3 required platform-native libraries
 * 
 * 4. Non-standard MIME types seen in the wild:
 *    - 'audio/x-mp3', 'audio/mpeg3' instead of 'audio/mpeg'
 *    - 'audio/x-m4a' instead of 'audio/m4a' (especially from Apple devices)
 *    - 'audio/vorbis' or 'audio/opus' instead of 'audio/ogg'
 *    - 'audio/x-wav' or 'audio/vnd.wave' instead of 'audio/wav'
 * 
 * 5. Mobile browsers may report different MIME types than desktop
 * 
 * This function normalizes all these variations to standard extensions.
 */
const getExtensionFromMimeType = (mimeType: string): string => {
  // Handle empty or invalid MIME types
  if (!mimeType || mimeType === 'application/octet-stream') {
    // Default to webm for recordings, as that's what MediaRecorder typically produces
    return 'webm';
  }
  
  // Normalize the MIME type to lowercase for consistent lookup
  const normalizedType = mimeType.toLowerCase().trim();
  
  const mimeToExt: Record<string, string> = {
    // MP3 variations
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/x-mp3': 'mp3',
    'audio/mpeg3': 'mp3',
    'audio/x-mpeg-3': 'mp3',
    
    // WAV variations
    'audio/wav': 'wav',
    'audio/wave': 'wav',
    'audio/x-wav': 'wav',
    'audio/vnd.wave': 'wav',
    'audio/x-pn-wav': 'wav',
    
    // OGG variations
    'audio/ogg': 'ogg',
    'application/ogg': 'ogg',
    'audio/x-ogg': 'ogg',
    'audio/vorbis': 'ogg',
    'audio/x-vorbis': 'ogg',
    'audio/opus': 'ogg',
    
    // WebM variations
    'audio/webm': 'webm',
    'video/webm': 'webm',
    
    // M4A/MP4 audio variations
    'audio/m4a': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/mp4': 'mp4',
    'video/mp4': 'mp4',
    'audio/mp4a-latm': 'm4a',
    'audio/mpeg4-generic': 'm4a',
    
    // AAC variations
    'audio/aac': 'aac',
    'audio/aacp': 'aac',
    'audio/x-aac': 'aac',
    'audio/3gpp': '3gp',
    'audio/3gpp2': '3gp',
    'video/3gpp': '3gp',
    'video/3gpp2': '3gp',
    
    // FLAC variations
    'audio/flac': 'flac',
    'audio/x-flac': 'flac',
    
    // Other formats
    'audio/basic': 'au',
    'audio/x-au': 'au',
    'audio/x-pn-au': 'au',
    'audio/vnd.rn-realaudio': 'ra',
    'audio/x-pn-realaudio': 'ra',
    'audio/x-realaudio': 'ra',
    'audio/amr': 'amr',
    'audio/amr-wb': 'awb',
    'audio/x-caf': 'caf',
    'audio/caf': 'caf',
  };
  
  // Direct lookup first
  const directMapping = mimeToExt[normalizedType];
  if (directMapping) {
    return directMapping;
  }
  
  // Fallback: extract from MIME type
  const parts = normalizedType.split('/');
  if (parts.length === 2) {
    // Remove any parameters (e.g., 'audio/mp4; codecs=...')
    const subtype = parts[1].split(';')[0].trim();
    // Remove 'x-' prefix if present
    const cleanSubtype = subtype.startsWith('x-') ? subtype.substring(2) : subtype;
    // Remove 'vnd.' prefix if present
    const finalSubtype = cleanSubtype.startsWith('vnd.') ? cleanSubtype.substring(4) : cleanSubtype;
    return finalSubtype || 'webm';
  }
  
  return 'webm'; // Default fallback
};

export const uploadConversationChunk = async (payload: {
  conversationId: string;
  chunk?: Blob | File;
  timestamp: Date;
  source: string;
  onProgress?: (progress: number) => void;
  runFinishHook: boolean;
}) => {
  if (!payload.chunk) {
    throw new Error("No chunk provided");
  }

  // Create a file with the correct extension and MIME type
  let fileName: string;
  
  if (payload.chunk instanceof File) {
    fileName = payload.chunk.name;
    // Check if file already has an extension
    if (!fileName.includes('.')) {
      // Add extension based on MIME type
      const ext = getExtensionFromMimeType(payload.chunk.type);
      fileName = `${fileName}.${ext}`;
    } else {
      // File has extension, validate it matches common audio formats
      const existingExt = fileName.split('.').pop()?.toLowerCase() || '';
      const knownAudioExts = ['mp3', 'wav', 'ogg', 'webm', 'm4a', 'mp4', 'aac', 'flac', 'opus', 'wma', 'amr', '3gp', 'au', 'ra', 'awb', 'caf'];
      
      if (!knownAudioExts.includes(existingExt)) {
        // Extension doesn't look like audio, add one based on MIME type
        const ext = getExtensionFromMimeType(payload.chunk.type);
        fileName = `${fileName}.${ext}`;
      }
    }
  } else {
    // For blobs, create a filename with proper extension
    const ext = getExtensionFromMimeType(payload.chunk.type);
    fileName = `chunk-${Date.now()}.${ext}`;
  }
  
  const fileToUpload = new File([payload.chunk], fileName, { type: payload.chunk.type });

  // If no progress callback provided, use standard Axios request
  if (!payload.onProgress) {
    const formData = new FormData();
    formData.append("chunk", fileToUpload);
    formData.append("timestamp", payload.timestamp.toISOString());
    formData.append("source", payload.source);
    formData.append("run_finish_hook", payload.runFinishHook.toString());

    return apiNoAuth.post<unknown, TConversationChunk[]>(
      `/participant/conversations/${payload.conversationId}/upload-chunk`,
      formData,
      {
        timeout: 600000,
        maxBodyLength: 25 * 1024 * 1024,
        maxContentLength: 25 * 1024 * 1024,
        headers: {
          "Content-Type": "multipart/form-data",
        },
      },
    );
  }

  // Use XMLHttpRequest for progress tracking
  return new Promise<TConversationChunk[]>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const formData = new FormData();

    formData.append("chunk", fileToUpload);
    formData.append("timestamp", payload.timestamp.toISOString());
    formData.append("source", payload.source);
    formData.append("run_finish_hook", payload.runFinishHook.toString());

    // Track upload progress
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && payload.onProgress) {
        // Throttle progress updates to prevent excessive UI updates
        // Report 0, 10, 20...90, 100 percent to reduce state updates
        const percentComplete = Math.round((event.loaded / event.total) * 100);
        const roundedPercent = Math.floor(percentComplete / 5) * 5;
        payload.onProgress(roundedPercent);
      }
    });

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const response = JSON.parse(xhr.responseText);
          // Always report 100% when done, regardless of throttling
          if (payload.onProgress) {
            payload.onProgress(100);
          }
          resolve(response);
        } catch (e) {
          reject(new Error("Invalid response format"));
        }
      } else {
        reject(new Error(`Upload failed with status ${xhr.status}`));
      }
    });

    xhr.addEventListener("error", () => {
      reject(new Error("Network error occurred during upload"));
    });

    xhr.addEventListener("abort", () => {
      reject(new Error("Upload was aborted"));
    });

    xhr.open(
      "POST",
      `${apiCommonConfig.baseURL}/participant/conversations/${payload.conversationId}/upload-chunk`,
    );

    // Include credentials if needed
    xhr.withCredentials = true;

    xhr.send(formData);
  });
};

export const uploadConversationText = async (payload: {
  conversationId: string;
  content: string;
  timestamp: Date;
  source: string;
}) => {
  return apiNoAuth.post<unknown, TConversationChunk>(
    `/participant/conversations/${payload.conversationId}/upload-text`,
    {
      content: payload.content,
      timestamp: payload.timestamp.toISOString(),
      source: payload.source,
    },
  );
};

export const initiateAndUploadConversationChunk = async (payload: {
  projectId: string;
  pin: string;
  namePrefix: string;
  tagIdList: string[];
  chunks: (Blob | File)[];
  timestamps: Date[];
  email?: string;
  onProgress?: (fileName: string, progress: number) => void;
  source?: string;
}) => {
  // Show a single toast for the overall upload process
  toast(`Starting upload of ${payload.chunks.length} file(s)`);

  // Limit concurrent uploads to avoid overwhelming the server
  const MAX_CONCURRENT = 3;
  const results: (TConversationChunk[] | { error: Error; name: string })[] = [];
  const fileQueue = [...Array(payload.chunks.length).keys()]; // Create array of indices [0,1,2...]
  const inProgress = new Set<number>();

  // Process uploads with concurrency control
  const processNext = async () => {
    // Keep processing until queue is empty and nothing in progress
    while (fileQueue.length > 0 || inProgress.size > 0) {
      // If we can start more uploads and there are files waiting
      while (inProgress.size < MAX_CONCURRENT && fileQueue.length > 0) {
        const index = fileQueue.shift()!;
        inProgress.add(index);

        // Start this upload (don't await here)
        processFile(index).finally(() => {
          inProgress.delete(index);
          // Try to process more files when this one finishes
          processNext();
        });
      }

      // If we've reached max concurrent uploads, wait for some to finish
      if (inProgress.size >= MAX_CONCURRENT || fileQueue.length === 0) {
        break;
      }
    }
  };

  // Process a single file
  const processFile = async (i: number) => {
    const chunk = payload.chunks[i];
    let name = "";

    // Get proper name based on chunk type
    if (payload.namePrefix) {
      name = payload.namePrefix;
    }

    // Determine if this is likely from MediaRecorder or file upload
    const isFile = chunk instanceof File;
    // Default source based on type if not explicitly provided
    const source =
      payload.source || (isFile ? "DASHBOARD_UPLOAD" : "PORTAL_AUDIO");

    if (isFile) {
      name += chunk.name;
    } else {
      // Use proper extension based on MIME type
      const ext = getExtensionFromMimeType(chunk.type);
      name += `chunk-${i}.${ext}`;
    }

    // Pass the chunk directly without normalization
    const normalizedChunk = chunk;

    try {
      // Create the conversation first
      const conversation = await initiateConversation({
        projectId: payload.projectId,
        email: payload.email,
        name: `${name}`,
        pin: payload.pin,
        source: source,
        tagIdList: payload.tagIdList,
      });

      // Then upload the chunk with progress tracking
      let progressHandler = undefined;
      if (payload.onProgress) {
        const callback = payload.onProgress; // Store in local variable
        progressHandler = (progress: number) => callback(name, progress);
      }

      const result = await uploadConversationChunk({
        conversationId: conversation.id,
        chunk: normalizedChunk,
        timestamp: payload.timestamps[i] ?? new Date(),
        source: source,
        onProgress: progressHandler,
        // we want to finish the conversation after the chunk is uploaded
        runFinishHook: true,
      });

      results[i] = result;
      return result;
    } catch (error) {
      console.error(`Error uploading file ${name}:`, error);
      // Store the error to potentially handle it
      results[i] = { error: error as Error, name };
      throw error; // Re-throw so the finally clause knows it failed
    }
  };

  // Start the processing
  await processNext();

  // Wait for all uploads to complete
  while (inProgress.size > 0) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Check if any uploads failed
  const failures = results.filter((r) => {
    return r && "error" in r && r.error !== undefined;
  });

  if (failures.length > 0) {
    console.error(`${failures.length} file(s) failed to upload`);
  }

  return results;
};

export const getProjectConversationCounts = async (projectId: string) => {
  const conversations = await directus.request(readItems("conversation", {
    filter: {
      project_id: {
        _eq: projectId,
      },
    },
    fields: ["id", "is_finished", "summary", "participant_name", "updated_at", "created_at"],
  }));

  const finishedConversations = conversations.filter((conversation) => conversation.is_finished);
  const pendingConversations = conversations.filter((conversation) => !conversation.is_finished);

  return {
    finished: finishedConversations.length,
    pending: pendingConversations.length,
    total: conversations.length,
    finishedConversations,
    pendingConversations,
  };
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
  auto_select_bool?: boolean,
) => {
  return api.post<unknown, TProjectChatContext>(
    `/chats/${chatId}/add-context`,
    {
      conversation_id: conversationId,
      auto_select_bool: auto_select_bool,
    },
  );
};

export const deleteChatContext = async (
  chatId: string,
  conversationId?: string,
  auto_select_bool?: boolean,
) => {
  return api.post<unknown, TProjectChatContext>(
    `/chats/${chatId}/delete-context`,
    {
      conversation_id: conversationId,
      auto_select_bool: auto_select_bool,
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
        {
          chat_message_metadata: [
            "type",
            "conversation",
            "ratio",
            "reference_text",
            {
              conversation: ["id", "participant_name"],
            }
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
    metadata: message.chat_message_metadata ?? [],
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

export const generateConversationSummary = async (conversationId: string) => {
  return apiNoAuth.post<
    unknown,
    { status: string; summary: string } | { status: string; message: string }
  >(`/conversations/${conversationId}/summarize`);
};

export const unsubscribeParticipant = async (
  projectId: string,
  token: string,
  email_opt_in: boolean
) => {
  return apiNoAuth.post(`/participant/${projectId}/report/unsubscribe`, {
    token,
    email_opt_in,
  });
};

// subscribe to notifications
export const submitNotificationParticipant = async (
  emails: string[],
  projectId: string,
  conversationId: string
) => {
  try {
    const response = await apiNoAuth.post('/participant/report/subscribe', {
      emails,
      project_id: projectId,
      conversation_id: conversationId
    })
    return response;
  } catch (error) {
    throw new Error("Failed to subscribe to notifications");
  }
};

export const deleteConversationById = async (conversationId: string) => {
  try {
    const response = await api.delete(`/conversations/${conversationId}`);
    return response;
  } catch (error: any) {
    const message =
      error?.response?.data?.detail || 'Failed to delete conversation';
    throw new Error(message);
  }
};

// check if the participant is eligible to unsubscribe
export const checkUnsubscribeStatus = async (
  token: string,
  projectId: string
) => {
  try {
    const response = await apiNoAuth.get('/participant/report/unsubscribe/eligibility', {
      params: { token, project_id: projectId },
    });

    return response;
  } catch (error) {
    throw new Error('No matching subscription found.');
  }
};