// @FIXME: this file must be decomposed into @/components/xxx/api/index.ts

import { readItems, updateItem } from "@directus/sdk";
import axios, {
	type AxiosError,
	type AxiosRequestConfig,
	type CreateAxiosDefaults,
} from "axios";
import { toast } from "@/components/common/Toaster";
import { API_BASE_URL, USE_PARTICIPANT_ROUTER } from "@/config";
import { directus, directusContent } from "./directus";
import type { EchoPortalTutorial } from "./typesDirectusContent";

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
	return apiNoAuth.get<unknown, Project>(`/participant/projects/${projectId}`);
};

export const getParticipantConversationById = async (
	projectId: string,
	conversationId: string,
) => {
	return apiNoAuth.get<unknown, Conversation>(
		`/participant/projects/${projectId}/conversations/${conversationId}`,
	);
};

export const getParticipantTutorialCardsBySlug = async (slug: string) => {
	return directusContent.request<EchoPortalTutorial[]>(
		readItems("echo__portal_tutorial", {
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
			filter: {
				slug: {
					_eq: slug,
				},
			},
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
				"id",
				"name",
				"description",
				"created_at",
				"user_input",
				"user_input_description",
				{
					aspects: [
						"id",
						"name",
						"short_summary",
						"description",
						"image_url",
						"view_id",
					],
				},
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

export const cloneProjectById = async ({
	projectId,
	name,
	language,
}: {
	projectId: string;
	name?: string;
	language?: string;
}) => {
	const payload: Record<string, string> = {};

	if (typeof name === "string" && name.trim().length > 0) {
		payload.name = name.trim();
	}

	if (typeof language === "string" && language.trim().length > 0) {
		payload.language = language.trim();
	}

	return api.post<unknown, string>(`/projects/${projectId}/clone`, {
		...payload,
	});
};

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
			source: payload.source,
			tag_id_list: payload.tagIdList,
			user_agent: navigator.userAgent ?? undefined,
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
	if (!mimeType || mimeType === "application/octet-stream") {
		// Default to webm for recordings, as that's what MediaRecorder typically produces
		return "webm";
	}

	// Normalize the MIME type to lowercase for consistent lookup
	const normalizedType = mimeType.toLowerCase().trim();

	const mimeToExt: Record<string, string> = {
		"application/ogg": "ogg",
		"audio/3gpp": "3gp",
		"audio/3gpp2": "3gp",

		// AAC variations
		"audio/aac": "aac",
		"audio/aacp": "aac",
		"audio/amr": "amr",
		"audio/amr-wb": "awb",

		// Other formats
		"audio/basic": "au",
		"audio/caf": "caf",

		// FLAC variations
		"audio/flac": "flac",

		// M4A/MP4 audio variations
		"audio/m4a": "m4a",
		"audio/mp3": "mp3",
		"audio/mp4": "mp4",
		"audio/mp4a-latm": "m4a",
		// MP3 variations
		"audio/mpeg": "mp3",
		"audio/mpeg3": "mp3",
		"audio/mpeg4-generic": "m4a",

		// OGG variations
		"audio/ogg": "ogg",
		"audio/opus": "ogg",
		"audio/vnd.rn-realaudio": "ra",
		"audio/vnd.wave": "wav",
		"audio/vorbis": "ogg",

		// WAV variations
		"audio/wav": "wav",
		"audio/wave": "wav",

		// WebM variations
		"audio/webm": "webm",
		"audio/x-aac": "aac",
		"audio/x-au": "au",
		"audio/x-caf": "caf",
		"audio/x-flac": "flac",
		"audio/x-m4a": "m4a",
		"audio/x-mp3": "mp3",
		"audio/x-mpeg-3": "mp3",
		"audio/x-ogg": "ogg",
		"audio/x-pn-au": "au",
		"audio/x-pn-realaudio": "ra",
		"audio/x-pn-wav": "wav",
		"audio/x-realaudio": "ra",
		"audio/x-vorbis": "ogg",
		"audio/x-wav": "wav",
		"video/3gpp": "3gp",
		"video/3gpp2": "3gp",
		"video/mp4": "mp4",
		"video/webm": "webm",
	};

	// Direct lookup first
	const directMapping = mimeToExt[normalizedType];
	if (directMapping) {
		return directMapping;
	}

	// Fallback: extract from MIME type
	const parts = normalizedType.split("/");
	if (parts.length === 2) {
		// Remove any parameters (e.g., 'audio/mp4; codecs=...')
		const subtype = parts[1].split(";")[0].trim();
		// Remove 'x-' prefix if present
		const cleanSubtype = subtype.startsWith("x-")
			? subtype.substring(2)
			: subtype;
		// Remove 'vnd.' prefix if present
		const finalSubtype = cleanSubtype.startsWith("vnd.")
			? cleanSubtype.substring(4)
			: cleanSubtype;
		return finalSubtype || "webm";
	}

	return "webm"; // Default fallback
};

export type UploadResult = {
	chunk_id: string;
	conversationId: string;
	file_url: string;
	source: string;
	timestamp: string;
};

/**
 * Upload a conversation chunk using presigned URL (direct to S3)
 *
 * This is the new, preferred method as it doesn't block the API server.
 * Includes retry logic and comprehensive error handling.
 * Returns data needed for confirmation step.
 */
export const uploadConversationChunkWithPresignedUrl = async (payload: {
	conversationId: string;
	chunk?: Blob | File;
	timestamp: Date;
	source: string;
	onProgress?: (progress: number) => void;
	runFinishHook?: boolean; // Ignored - kept for backward compatibility
}): Promise<UploadResult> => {
	if (!payload.chunk) {
		throw new Error("No chunk provided");
	}

	// Ensure we have a proper filename
	let fileName: string;
	if (payload.chunk instanceof File) {
		fileName = payload.chunk.name;
	} else {
		const ext = getExtensionFromMimeType(payload.chunk.type);
		fileName = `chunk-${Date.now()}.${ext}`;
	}

	// Step 1: Get presigned URL from API (fast, <100ms)
	console.log(`[Upload] Requesting presigned URL for ${fileName}`);

	let presignedResponse: {
		chunk_id: string;
		upload_url: string;
		fields: Record<string, string>;
		file_url: string;
	};

	try {
		presignedResponse = await apiNoAuth.post<
			unknown,
			{
				chunk_id: string;
				upload_url: string;
				fields: Record<string, string>;
				file_url: string;
			}
		>(`/participant/conversations/${payload.conversationId}/get-upload-url`, {
			content_type: payload.chunk.type,
			conversation_id: payload.conversationId,
			filename: fileName,
		});
	} catch (error) {
		console.error("[Upload] Failed to get presigned URL:", error);
		throw new Error("Failed to get upload URL from server. Please try again.");
	}

	const { chunk_id, upload_url, fields, file_url } = presignedResponse;
	console.log(`[Upload] Got presigned URL for chunk ${chunk_id}`);

	// Step 2: Upload directly to S3 using presigned URL with retry
	const formData = new FormData();

	// Add all required fields from presigned POST
	Object.entries(fields).forEach(([key, value]) => {
		formData.append(key, value);
	});

	// Add the file itself (must be last for DigitalOcean Spaces!)
	formData.append("file", payload.chunk, fileName);

	// Retry logic for S3 upload
	const maxRetries = 3;
	let lastError: Error | null = null;

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			console.log(
				`[Upload] Uploading to S3 (attempt ${attempt}/${maxRetries})...`,
			);

			await axios.post(upload_url, formData, {
				headers: {
					// Don't set Content-Type - browser will set it with boundary
				},
				onUploadProgress: (progressEvent) => {
					if (progressEvent.total && payload.onProgress) {
						// Report 0-90% during S3 upload, reserve 90-100% for confirmation
						const s3Progress =
							(progressEvent.loaded / progressEvent.total) * 90;
						payload.onProgress(Math.round(s3Progress));
					}
				},
				timeout: 300000, // 5 minutes
			});

			console.log(`[Upload] S3 upload successful for chunk ${chunk_id}`);
			break; // Success, exit retry loop
		} catch (error) {
			lastError = error as Error;
			console.error(
				`[Upload] S3 upload failed (attempt ${attempt}/${maxRetries}):`,
				error,
			);

			if (attempt < maxRetries) {
				// Exponential backoff: 1s, 2s, 4s
				const delay = 2 ** (attempt - 1) * 1000;
				console.log(`[Upload] Retrying in ${delay}ms...`);
				await new Promise((resolve) => setTimeout(resolve, delay));
			} else {
				throw new Error(
					`Failed to upload file to S3 after ${maxRetries} attempts. ` +
						"Please check your internet connection and try again. " +
						`Error: ${lastError?.message || "Unknown error"}`,
				);
			}
		}
	}

	// Step 3: Return data needed for confirmation
	// The confirmation will be handled separately in the mutation hook
	// Report 90% progress before confirmation
	payload.onProgress?.(90);

	return {
		chunk_id,
		conversationId: payload.conversationId,
		file_url,
		source: payload.source,
		timestamp: payload.timestamp.toISOString(),
	};
};

// Export the new presigned URL method as the default uploadConversationChunk
export const uploadConversationChunk = uploadConversationChunkWithPresignedUrl;

// Confirms the upload with the API after S3 upload is complete
export const confirmConversationChunkUpload = async (payload: {
	conversationId: string;
	chunk_id: string;
	file_url: string;
	source: string;
	timestamp: string;
	onProgress?: (progress: number) => void;
}) => {
	console.log(
		`[Upload] Confirming upload with API for chunk ${payload.chunk_id}`,
	);

	const confirmResponse = await apiNoAuth.post<unknown, TConversationChunk>(
		`/participant/conversations/${payload.conversationId}/confirm-upload`,
		{
			chunk_id: payload.chunk_id,
			file_url: payload.file_url,
			source: payload.source,
			timestamp: payload.timestamp,
		},
	);

	// Report 100% after successful confirmation
	payload.onProgress?.(100);
	console.log(
		`[Upload] Upload confirmed successfully for chunk ${payload.chunk_id}`,
	);

	return confirmResponse;
};

/**
 * Legacy upload method (through API server)
 *
 * Keep this for backward compatibility but prefer presigned URL method.
 */
export const uploadConversationChunkLegacy = async (payload: {
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
		if (!fileName.includes(".")) {
			// Add extension based on MIME type
			const ext = getExtensionFromMimeType(payload.chunk.type);
			fileName = `${fileName}.${ext}`;
		} else {
			// File has extension, validate it matches common audio formats
			const existingExt = fileName.split(".").pop()?.toLowerCase() || "";
			const knownAudioExts = [
				"mp3",
				"wav",
				"ogg",
				"webm",
				"m4a",
				"mp4",
				"aac",
				"flac",
				"opus",
				"wma",
				"amr",
				"3gp",
				"au",
				"ra",
				"awb",
				"caf",
			];

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

	const fileToUpload = new File([payload.chunk], fileName, {
		type: payload.chunk.type,
	});

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
				headers: {
					"Content-Type": "multipart/form-data",
				},
				maxBodyLength: 25 * 1024 * 1024,
				maxContentLength: 25 * 1024 * 1024,
				timeout: 600000,
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
				} catch (_e) {
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
			source: payload.source,
			timestamp: payload.timestamp.toISOString(),
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
}): Promise<(TConversationChunk | { error: Error; name: string })[]> => {
	// Show a single toast for the overall upload process
	toast(`Starting upload of ${payload.chunks.length} file(s)`);

	// Limit concurrent uploads
	const MAX_CONCURRENT = 3;
	const results: (TConversationChunk | { error: Error; name: string })[] = [];
	const fileQueue = [...Array(payload.chunks.length).keys()];
	const inProgress = new Set<number>();

	// Track conversation ID for finish hook
	let conversationId: string | null = null;

	// Process a single file
	const processFile = async (i: number) => {
		const chunk = payload.chunks[i];
		let fileName = "";

		if (chunk instanceof File) {
			fileName = chunk.name;
		} else {
			const ext = getExtensionFromMimeType(chunk.type);
			fileName = `recording-${i + 1}.${ext}`;
		}

		const source = payload.source || "PORTAL_AUDIO";

		try {
			// Create the conversation first (one per file in this implementation)
			const conversation = await initiateConversation({
				email: payload.email,
				name: `${payload.namePrefix} - ${fileName}`,
				pin: payload.pin,
				projectId: payload.projectId,
				source: source,
				tagIdList: payload.tagIdList,
			});

			// Store conversation ID for finish hook
			if (!conversationId) {
				conversationId = conversation.id;
			}

			// Upload using new presigned URL method
			const uploadResult = await uploadConversationChunkWithPresignedUrl({
				chunk,
				conversationId: conversation.id,
				onProgress: (progress) => {
					payload.onProgress?.(fileName, progress);
				},
				source,
				timestamp: payload.timestamps[i] ?? new Date(),
			});

			// Confirm the upload to complete the process
			const result = await confirmConversationChunkUpload({
				...uploadResult,
				onProgress: (progress) => {
					payload.onProgress?.(fileName, progress);
				},
			});

			results[i] = result;
			return result;
		} catch (error) {
			console.error(`Upload failed for ${fileName}:`, error);
			results[i] = {
				error: error instanceof Error ? error : new Error("Unknown error"),
				name: fileName,
			};
			throw error;
		}
	};

	// Process uploads with concurrency control
	const processNext = async () => {
		while (fileQueue.length > 0 || inProgress.size > 0) {
			while (inProgress.size < MAX_CONCURRENT && fileQueue.length > 0) {
				const index = fileQueue.shift()!;
				inProgress.add(index);

				processFile(index).finally(() => {
					inProgress.delete(index);
					processNext();
				});
			}

			if (inProgress.size >= MAX_CONCURRENT || fileQueue.length === 0) {
				break;
			}
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
		toast.error(`${failures.length} file(s) failed to upload`);
	} else {
		toast.success(`All ${payload.chunks.length} file(s) uploaded successfully`);
	}

	// IMPORTANT: Trigger finish hook after all uploads complete
	// This triggers: audio merging, ETL pipeline, summarization
	if (conversationId && failures.length === 0) {
		console.log(
			`[Upload] Triggering finish hook for conversation ${conversationId}`,
		);
		try {
			await finishConversation(conversationId);
			console.log("[Upload] Finish hook triggered successfully");
		} catch (error) {
			console.error("[Upload] Failed to trigger finish hook:", error);
			// Don't throw - uploads succeeded, this is just post-processing
		}
	}

	return results;
};

export const getProjectConversationCounts = async (projectId: string) => {
	const conversations = await directus.request(
		readItems("conversation", {
			fields: [
				"id",
				"is_finished",
				"participant_name",
				"updated_at",
				"created_at",
			],
			filter: {
				project_id: {
					_eq: projectId,
				},
			},
		}),
	);

	const finishedConversations = conversations.filter(
		(conversation) => conversation.is_finished,
	);
	const pendingConversations = conversations.filter(
		(conversation) => !conversation.is_finished,
	);

	return {
		finished: finishedConversations.length,
		finishedConversations,
		pending: pendingConversations.length,
		pendingConversations,
		total: conversations.length,
	};
};

export const getConversationContentLink = (
	conversationId: string,
	returnUrl = false,
) =>
	`${apiCommonConfig.baseURL}/conversations/${conversationId}/content${
		returnUrl ? "?return_url=true" : ""
	}`;

export const getConversationChunkContentLink = (
	conversationId: string,
	chunkId: string,
	returnUrl = false,
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
		additional_context: payload.additionalContext,
		language: payload.language,
		query: payload.query,
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
	usePiiRedaction: boolean,
) => {
	return api.post<
		unknown,
		{ status: string; message: string; new_conversation_id: string }
	>(`/conversations/${conversationId}/retranscribe`, {
		new_conversation_name: newConversationName,
		use_pii_redaction: usePiiRedaction,
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
			auto_select_bool: auto_select_bool,
			conversation_id: conversationId,
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
			auto_select_bool: auto_select_bool,
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

export type ChatMode = "overview" | "deep_dive";

export type InitializeChatModeResponse = {
	chat_mode: ChatMode;
	conversations_added: number;
	conversations_summarized: number;
	message: string;
};

export const initializeChatMode = async (
	chatId: string,
	mode: ChatMode,
	projectId: string,
) => {
	return api.post<unknown, InitializeChatModeResponse>(
		`/chats/${chatId}/initialize-mode`,
		{
			mode,
			project_id: projectId,
		},
	);
};

export const getChatSuggestions = async (
	chatId: string,
	language = "en",
): Promise<TSuggestionsResponse> => {
	return api.get<unknown, TSuggestionsResponse>(
		`/chats/${chatId}/suggestions`,
		{
			params: { language },
		},
	);
};

export const getChatHistory = async (chatId: string): Promise<ChatHistory> => {
	const data = await directus.request<ProjectChatMessage[]>(
		readItems("project_chat_message", {
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
			filter: {
				project_chat_id: chatId,
			},
			sort: "date_created",
		}),
	);

	// @ts-expect-error TODO
	return data.map((message) => ({
		_original: message,
		content: message.text ?? "",
		createdAt: message.date_created,
		id: message.id,
		// metadata: message.chat_message_metadata ?? [],
		role: message.message_from as "user" | "assistant",
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

export type VerificationTopicTranslation = {
	label: string;
};

export type VerificationTopicMetadata = {
	key: string;
	prompt?: string | null;
	icon?: string | null;
	sort?: number | null;
	translations: Record<string, VerificationTopicTranslation>;
};

export type VerificationTopicsResponse = {
	selected_topics: string[];
	available_topics: VerificationTopicMetadata[];
};

export const getVerificationTopics = async (projectId: string) => {
	return apiNoAuth.get<unknown, VerificationTopicsResponse>(
		`/verify/topics/${projectId}`,
	);
};

export type VerificationArtifact = {
	id: string;
	approved_at?: string | null;
	date_created?: string | null;
	content: string;
	conversation_id: string;
	key: string;
	read_aloud_stream_url: string;
};

export type VerificationArtifactDetail = {
	id: string;
	content: string;
	date_created: string | null;
	approved_at?: string | null;
	key: string;
	read_aloud_stream_url: string;
};

export const generateVerificationArtefact = async (payload: {
	conversationId: string;
	topicList: string[];
	signal?: AbortSignal;
}): Promise<VerificationArtifact[]> => {
	const response = await apiNoAuth.post<
		unknown,
		{
			artifact_list?: VerificationArtifact[];
		}
	>(
		"/verify/generate",
		{
			conversation_id: payload.conversationId,
			topic_list: payload.topicList,
		},
		{
			signal: payload.signal,
		},
	);

	return response?.artifact_list ?? [];
};

export type UpdateVerificationArtefactPayload = {
	artifactId: string;
	useConversation?: {
		conversationId: string;
		timestamp: string;
	};
	content?: string;
	approvedAt?: string;
};

export const updateVerificationArtefact = async ({
	artifactId,
	useConversation,
	content,
	approvedAt,
}: UpdateVerificationArtefactPayload) => {
	const response = await apiNoAuth.put<unknown, VerificationArtifact>(
		`/verify/artifact/${artifactId}`,
		{
			approvedAt,
			content,
			useConversation: useConversation
				? {
						conversationId: useConversation.conversationId,
						timestamp: useConversation.timestamp,
					}
				: undefined,
		},
	);
	return response;
};

export const getVerificationArtefacts = async (conversationId: string) => {
	return apiNoAuth.get<unknown, VerificationArtifact[]>(
		`/verify/artifacts/${conversationId}`,
	);
};

export const getVerificationArtefactById = async (artifactId: string) => {
	return apiNoAuth.get<unknown, VerificationArtifactDetail>(
		`/verify/artifact/${artifactId}`,
	);
};

export const unsubscribeParticipant = async (
	projectId: string,
	token: string,
	email_opt_in: boolean,
) => {
	return apiNoAuth.post(`/participant/${projectId}/report/unsubscribe`, {
		email_opt_in,
		token,
	});
};

// subscribe to notifications
export const submitNotificationParticipant = async (
	emails: string[],
	projectId: string,
	conversationId: string,
) => {
	try {
		const response = await apiNoAuth.post("/participant/report/subscribe", {
			conversation_id: conversationId,
			emails,
			project_id: projectId,
		});
		return response;
	} catch (_error) {
		throw new Error("Failed to subscribe to notifications");
	}
};

export const deleteConversationById = async (conversationId: string) => {
	try {
		const response = await api.delete(`/conversations/${conversationId}`);
		return response;
	} catch (error: any) {
		const message =
			error?.response?.data?.detail || "Failed to delete conversation";
		throw new Error(message);
	}
};

// check if the participant is eligible to unsubscribe
export const checkUnsubscribeStatus = async (
	token: string,
	projectId: string,
) => {
	try {
		const response = await apiNoAuth.get(
			"/participant/report/unsubscribe/eligibility",
			{
				params: { project_id: projectId, token },
			},
		);

		return response;
	} catch (_error) {
		throw new Error("No matching subscription found.");
	}
};

// =============================================================================
// Webhook API
// =============================================================================

export type WebhookEvent =
	| "conversation.created"
	| "conversation.transcribed"
	| "conversation.summarized";

export type WebhookStatus = "published" | "draft" | "archived";

export interface Webhook {
	id: string;
	name: string | null;
	url: string | null;
	events: WebhookEvent[] | null;
	status: WebhookStatus | null;
	date_created: string | null;
	date_updated: string | null;
}

export interface WebhookCreatePayload {
	name: string;
	url: string;
	secret?: string;
	events: WebhookEvent[];
}

export interface WebhookUpdatePayload {
	name?: string;
	url?: string;
	secret?: string;
	events?: WebhookEvent[];
	status?: WebhookStatus;
}

export interface WebhookTestResult {
	success: boolean;
	status_code: number | null;
	message: string;
}

export const getProjectWebhooks = async (projectId: string): Promise<Webhook[]> => {
	const response = await api.get<unknown, Webhook[]>(`/projects/${projectId}/webhooks`);
	return response;
};

export const createProjectWebhook = async (
	projectId: string,
	payload: WebhookCreatePayload,
): Promise<Webhook> => {
	const response = await api.post<unknown, Webhook>(`/projects/${projectId}/webhooks`, payload);
	return response;
};

export const updateProjectWebhook = async (
	projectId: string,
	webhookId: string,
	payload: WebhookUpdatePayload,
): Promise<Webhook> => {
	const response = await api.patch<unknown, Webhook>(
		`/projects/${projectId}/webhooks/${webhookId}`,
		payload,
	);
	return response;
};

export const deleteProjectWebhook = async (
	projectId: string,
	webhookId: string,
): Promise<void> => {
	await api.delete(`/projects/${projectId}/webhooks/${webhookId}`);
};

export const testProjectWebhook = async (
	projectId: string,
	webhookId: string,
): Promise<WebhookTestResult> => {
	const response = await api.post<unknown, WebhookTestResult>(
		`/projects/${projectId}/webhooks/${webhookId}/test`,
	);
	return response;
};
