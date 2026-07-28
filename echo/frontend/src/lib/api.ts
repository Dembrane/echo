// @FIXME: this file must be decomposed into @/components/xxx/api/index.ts

import { readItems } from "@directus/sdk";
import axios, {
	type AxiosError,
	type AxiosRequestConfig,
	type CreateAxiosDefaults,
} from "axios";
import { toast } from "@/components/common/Toaster";
import { API_BASE_URL, USE_PARTICIPANT_ROUTER } from "@/config";
import { bff } from "./bff";
import { directus } from "./directus";

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
	return apiNoAuth.get<unknown, ParticipantProject>(
		`/participant/projects/${projectId}`,
	);
};

export const getParticipantConversationById = async (
	projectId: string,
	conversationId: string,
) => {
	return apiNoAuth.get<unknown, Conversation>(
		`/participant/projects/${projectId}/conversations/${conversationId}`,
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
	visitorId?: string;
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
			visitor_id: payload.visitorId ?? undefined,
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
 * Pre-flight check: ask the server for a presigned PUT URL and attempt a tiny
 * upload to S3. Returns true when S3 is reachable, false otherwise.
 */
export const checkS3Connectivity = async (
	conversationId: string,
): Promise<boolean> => {
	try {
		const { probe_url } = await apiNoAuth.post<unknown, { probe_url: string }>(
			`/participant/conversations/${conversationId}/check-s3`,
		);

		await fetch(probe_url, {
			body: "probe",
			headers: { "Content-Type": "text/plain" },
			method: "PUT",
			signal: AbortSignal.timeout(8000),
		}).then((res) => {
			if (!res.ok) throw new Error(`S3 probe returned ${res.status}`);
		});

		return true;
	} catch (error) {
		console.error("[S3 Check] Connectivity check failed:", error);
		return false;
	}
};

export type ParticipantPingTelemetry = {
	/** The portal knows its project from the URL; lets the server fan a
	 * real-time nudge to open monitor streams without a DB lookup. */
	project_id?: string;
	state?: string;
	mode?: "voice" | "text";
	screen?: string;
	/** The pre-conversation funnel dot this recording grew out of. */
	visitor_id?: string;
	/** Live mic input level (0..1 RMS) so the host can see audio flowing. */
	audio_level?: number;
	/** Accumulated recording seconds, excluding paused gaps (host timer reads it). */
	recorded_seconds?: number;
	/** Seconds into the current recording run (resets on resume), for the monitor's
	 * ramp-up grace so it doesn't false-alarm "audio stopped" after a resume. */
	segment_seconds?: number;
	/** Client-side send time (epoch ms), stamped when the ping is initiated, so
	 * the server can drop an out-of-order ping and keep the newest state. */
	client_ts?: number;
	network?: {
		online?: boolean;
		effective_type?: string;
		downlink?: number;
		rtt?: number;
	};
	battery?: { level?: number; charging?: boolean };
};

export type VisitorPingTelemetry = {
	stage?: string;
	name?: string;
	tags?: string[];
	tags_preselected?: boolean;
	scan_count?: number;
	device?: string;
	network?: {
		online?: boolean;
		effective_type?: string;
		downlink?: number;
		rtt?: number;
	};
	battery?: { level?: number; charging?: boolean };
};

/**
 * Pre-conversation funnel beacon. Reports where a visitor is in onboarding
 * (scanned / terms / mic / profile) before a conversation exists, keyed by a
 * device-persistent visitor id. Best-effort; failures are swallowed.
 */
export const pingVisitor = async (
	projectId: string,
	visitorId: string,
	telemetry?: VisitorPingTelemetry,
): Promise<void> => {
	try {
		await apiNoAuth.post(
			`/participant/projects/${projectId}/visitors/${visitorId}/ping`,
			telemetry ?? undefined,
		);
	} catch {
		// Non-critical; the next beacon re-establishes funnel presence.
	}
};

/**
 * Participant liveness + telemetry beacon. Called every few seconds while the
 * participant is in a conversation so the host monitor can tell what they are
 * doing (recording, paused, verifying, ...) between audio chunks. Telemetry is
 * optional and best-effort: failures are swallowed so a blip never disrupts
 * recording.
 */
export const pingConversation = async (
	conversationId: string,
	telemetry?: ParticipantPingTelemetry,
): Promise<void> => {
	try {
		await apiNoAuth.post(
			`/participant/conversations/${conversationId}/ping`,
			telemetry ?? undefined,
		);
	} catch {
		// Non-critical; the next ping (or a chunk upload) re-establishes liveness.
	}
};

/**
 * Terminal "left" beacon, fired when the participant closes the tab without
 * finishing. Uses keepalive fetch (not axios) so the request survives page
 * unload, with JSON to match the ping endpoint and its existing CORS. Without
 * it a graceful close would read as "offline" via the heartbeat grace instead.
 * Best-effort: any failure is swallowed.
 */
export const pingConversationLeft = (
	conversationId: string,
	projectId?: string,
): void => {
	try {
		if (typeof fetch !== "function") return;
		void fetch(
			`${API_BASE_URL}/participant/conversations/${conversationId}/ping`,
			{
				// client_ts orders this against regular pings so a late in-flight
				// ping can't clobber "left"; stamped now (the latest moment).
				body: JSON.stringify({
					client_ts: Date.now(),
					project_id: projectId,
					state: "left",
				}),
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				keepalive: true,
				method: "POST",
			},
		).catch(() => {});
	} catch {
		// Best-effort; a blocked unload request just falls back to "offline".
	}
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

	// Each uploaded file creates its own conversation.
	// We need to remember every conversation ID so we can call finishConversation()
	// on each one after uploads complete. Without this, only the first conversation
	// would enter the processing pipeline (transcription, merging, duration, etc.).
	const conversationIdByFileIndex = new Map<number, string>();

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
			const conversation = await initiateConversation({
				email: payload.email,
				name: `${payload.namePrefix} - ${fileName}`,
				pin: payload.pin,
				projectId: payload.projectId,
				source: source,
				tagIdList: payload.tagIdList,
			});

			conversationIdByFileIndex.set(i, conversation.id);

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

	// Collect conversation IDs for files that uploaded successfully.
	// Failed uploads are skipped — they have no conversation to finish.
	const succeededConversationIds = results.reduce<string[]>(
		(ids, result, i) => {
			const isFailure = result && "error" in result;
			const conversationId = conversationIdByFileIndex.get(i);
			if (!isFailure && conversationId) {
				ids.push(conversationId);
			}
			return ids;
		},
		[],
	);

	// Call finishConversation() for every successful upload, concurrently.
	// This triggers the backend pipeline: transcription → merging → duration → summary.
	// Each call is independent, so one failure won't block the others.
	await Promise.all(
		succeededConversationIds.map(async (conversationId) => {
			try {
				await finishConversation(conversationId);
				console.log(
					`[Upload] Finish hook triggered for conversation ${conversationId}`,
				);
			} catch (error) {
				console.error(
					`[Upload] Failed to finish conversation ${conversationId}:`,
					error,
				);
			}
		}),
	);

	return results;
};

export const getProjectConversationCounts = async (projectId: string) => {
	// Direct Directus reads 403 since the lockdown; go through the BFF.
	const conversations = await bff.get<
		Pick<
			Conversation,
			"id" | "is_finished" | "participant_name" | "updated_at" | "created_at"
		>[]
	>("/conversations", {
		fields: "id,is_finished,participant_name,updated_at,created_at",
		limit: 1000,
		project_id: projectId,
	});

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

export interface ConversationEmailsResponse {
	emails_csv: string;
	count: number;
}

export const getConversationEmails = async (
	conversationId: string,
): Promise<ConversationEmailsResponse> => {
	return api.get<unknown, ConversationEmailsResponse>(
		`/conversations/${conversationId}/emails`,
	);
};

export const retranscribeConversation = async (
	conversationId: string,
	newConversationName: string,
	usePiiRedaction: boolean,
	attachVerifiedArtifacts?: boolean,
) => {
	return api.post<
		unknown,
		{ status: string; message: string; new_conversation_id: string }
	>(`/conversations/${conversationId}/retranscribe`, {
		attach_verified_artifacts: attachVerifiedArtifacts,
		new_conversation_name: newConversationName,
		use_pii_redaction: usePiiRedaction,
	});
};

export const getProjectChatContext = async (chatId: string) => {
	return api.get<unknown, TProjectChatContext>(`/chats/${chatId}/context`);
};

export const addChatContext = async (
	chatId: string,
	options?: {
		conversationId?: string;
		select_all?: boolean;
		project_id?: string;
		tag_ids?: string[];
		verified_only?: boolean;
		search_text?: string;
	},
) => {
	return api.post<unknown, AddContextResponse>(`/chats/${chatId}/add-context`, {
		conversation_id: options?.conversationId,
		project_id: options?.project_id,
		search_text: options?.search_text,
		select_all: options?.select_all,
		tag_ids: options?.tag_ids,
		verified_only: options?.verified_only,
	});
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

export const selectAllContext = async (
	chatId: string,
	projectId: string,
	options?: {
		tagIds?: string[];
		verifiedOnly?: boolean;
		searchText?: string;
	},
) => {
	// Uses addChatContext with select_all=true
	const response = await addChatContext(chatId, {
		project_id: projectId,
		search_text: options?.searchText,
		select_all: true,
		tag_ids: options?.tagIds,
		verified_only: options?.verifiedOnly,
	});
	// Map to SelectAllContextResponse for backward compatibility
	return {
		added: response?.added ?? [],
		context_limit_reached: response?.context_limit_reached ?? false,
		skipped: response?.skipped ?? [],
		total_processed: response?.total_processed ?? 0,
	} satisfies SelectAllContextResponse;
};

export type ChatMode = "overview" | "deep_dive" | "agentic";

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

export type AgenticRunStatus =
	| "queued"
	| "running"
	| "completed"
	| "failed"
	| "timeout";

export type AgenticRun = {
	id: string;
	project_id: string;
	project_chat_id?: string | null;
	directus_user_id: string;
	status: AgenticRunStatus;
	last_event_seq: number;
	latest_output?: string | null;
	latest_error?: string | null;
	latest_error_code?: string | null;
	started_at?: string | null;
	completed_at?: string | null;
};

export type AgenticRunEvent = {
	id: number;
	project_agentic_run_id: string;
	seq: number;
	event_type: string;
	payload: Record<string, unknown> | null;
	timestamp: string;
};

export type AgenticRunEventsResponse = {
	run_id: string;
	status: AgenticRunStatus;
	events: AgenticRunEvent[];
	next_seq: number;
	done: boolean;
};

export type AgenticRunStopResponse = {
	run_id: string;
	turn_seq: number;
	status: "stopping";
};

export const createAgenticRun = async (payload: {
	project_id: string;
	project_chat_id?: string;
	message: string;
	language?: string;
}) => {
	return api.post<unknown, AgenticRun>("/agentic/runs", payload);
};

export const appendAgenticRunMessage = async (
	runId: string,
	payload: {
		message: string;
		language?: string;
	},
) => {
	return api.post<unknown, AgenticRun>(
		`/agentic/runs/${runId}/messages`,
		payload,
	);
};

export const getAgenticRun = async (runId: string) => {
	return api.get<unknown, AgenticRun>(`/agentic/runs/${runId}`);
};

export const getLatestAgenticRunForChat = async (chatId: string) => {
	return api.get<unknown, AgenticRun>(`/agentic/chats/${chatId}/latest-run`);
};

export const getAgenticRunEvents = async (runId: string, afterSeq = 0) => {
	return api.get<unknown, AgenticRunEventsResponse>(
		`/agentic/runs/${runId}/events`,
		{
			params: {
				after_seq: afterSeq,
			},
		},
	);
};

type StreamAgenticRunOptions = {
	afterSeq?: number;
	signal?: AbortSignal;
	onEvent: (event: AgenticRunEvent) => void;
	onHeartbeat?: () => void;
};

const parseSseFrame = (
	frame: string,
): { eventType: string; data: string | null } | null => {
	const trimmed = frame.trim();
	if (!trimmed) return null;

	const lines = trimmed.split("\n");
	let eventType = "message";
	const dataLines: string[] = [];

	for (const line of lines) {
		if (line.startsWith("event:")) {
			eventType = line.slice("event:".length).trim();
			continue;
		}
		if (line.startsWith("data:")) {
			dataLines.push(line.slice("data:".length).trimStart());
		}
	}

	return {
		data: dataLines.length > 0 ? dataLines.join("\n") : null,
		eventType,
	};
};

export const streamAgenticRun = async (
	runId: string,
	options: StreamAgenticRunOptions,
) => {
	const afterSeq = options.afterSeq ?? 0;
	const response = await fetch(
		`${API_BASE_URL}/agentic/runs/${runId}/stream?after_seq=${afterSeq}`,
		{
			credentials: "include",
			headers: {
				Accept: "text/event-stream",
			},
			method: "POST",
			signal: options.signal,
		},
	);

	if (!response.ok) {
		throw new Error(`Failed to stream run (${response.status})`);
	}

	if (!response.body) {
		throw new Error("Streaming response body is missing");
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			let separatorIndex = buffer.indexOf("\n\n");
			while (separatorIndex !== -1) {
				const frame = buffer.slice(0, separatorIndex);
				buffer = buffer.slice(separatorIndex + 2);

				const parsed = parseSseFrame(frame);
				if (parsed) {
					if (parsed.eventType === "heartbeat") {
						options.onHeartbeat?.();
					} else if (parsed.data) {
						try {
							const event = JSON.parse(parsed.data) as AgenticRunEvent;
							options.onEvent(event);
						} catch {
							// Ignore malformed frames and continue streaming.
						}
					}
				}

				separatorIndex = buffer.indexOf("\n\n");
			}
		}
	} finally {
		reader.releaseLock();
	}
};

export const stopAgenticRun = async (runId: string) => {
	return api.post<unknown, AgenticRunStopResponse>(
		`/agentic/runs/${runId}/stop`,
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
	// BFF default is 100; lift to its max so long chats aren't truncated.
	const data = await bff.get<ProjectChatMessage[]>("/chat-messages", {
		chat_id: chatId,
		limit: 500,
	});

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
	userInstructions?: string;
	scheduledAt?: string;
	otherPayload?: Partial<ProjectReport>;
}) => {
	const response = await api.post<unknown, ProjectReport>(
		`/projects/${payload.projectId}/create-report`,
		{
			language: payload.language,
			scheduled_at: payload.scheduledAt || undefined,
			user_instructions: payload.userInstructions || undefined,
		},
	);

	if (payload.otherPayload) {
		await updateProjectReport(
			payload.projectId,
			response.id,
			payload.otherPayload,
		);
	}

	return response;
};

export const cancelScheduledReport = async (
	projectId: string,
	reportId: number,
) => {
	return api.post<unknown, { cancelled: boolean }>(
		`/projects/${projectId}/reports/${reportId}/cancel-schedule`,
	);
};

export const listProjectReports = async (projectId: string) => {
	return api.get<
		unknown,
		(Pick<
			ProjectReport,
			| "id"
			| "status"
			| "date_created"
			| "language"
			| "user_instructions"
			| "scheduled_at"
		> & { title?: string | null })[]
	>(`/projects/${projectId}/reports`);
};

export const getLatestProjectReport = async (projectId: string) => {
	return api.get<
		unknown,
		| (Pick<
				ProjectReport,
				| "id"
				| "status"
				| "project_id"
				| "show_portal_link"
				| "date_created"
				| "error_message"
		  > & { title?: string | null })
		| null
	>(`/projects/${projectId}/reports/latest`);
};

export const getProjectReportDetail = async (
	projectId: string,
	reportId: number,
) => {
	return api.get<unknown, ProjectReport>(
		`/projects/${projectId}/reports/${reportId}/detail`,
	);
};

export const updateProjectReport = async (
	projectId: string,
	reportId: number,
	payload: Partial<ProjectReport>,
) => {
	return api.patch<unknown, ProjectReport>(
		`/projects/${projectId}/reports/${reportId}`,
		payload,
	);
};

export const deleteProjectReport = async (
	projectId: string,
	reportId: number,
) => {
	return api.delete<unknown, { deleted: boolean }>(
		`/projects/${projectId}/reports/${reportId}`,
	);
};

export const getProjectReportViews = async (
	projectId: string,
	reportId: number,
) => {
	return api.get<unknown, { total: number; recent: number }>(
		`/projects/${projectId}/reports/${reportId}/views`,
	);
};

export const getPublicLatestProjectReport = async (projectId: string) => {
	return apiNoAuth.get<
		unknown,
		Pick<
			ProjectReport,
			"id" | "status" | "project_id" | "show_portal_link"
		> | null
	>(`/participant/${projectId}/report/latest`);
};

export const getPublicProjectReportDetail = async (
	projectId: string,
	reportId: number,
) => {
	return apiNoAuth.get<unknown, ProjectReport>(
		`/participant/${projectId}/report/${reportId}/detail`,
	);
};

export const getPublicProjectReportViews = async (projectId: string) => {
	return apiNoAuth.get<unknown, { recent: number }>(
		`/participant/${projectId}/report/views`,
	);
};

export const createPublicReportMetric = async (
	projectId: string,
	payload: { project_report_id: number; type: string },
) => {
	return apiNoAuth.post<unknown, { status: string }>(
		`/participant/${projectId}/report/metric`,
		payload,
	);
};

export const checkReportNeedsUpdate = async (
	projectId: string,
	reportId: number,
) => {
	return api.get<unknown, { needs_update: boolean }>(
		`/projects/${projectId}/reports/${reportId}/needs-update`,
	);
};

export const getProjectParticipantCount = async (projectId: string) => {
	return api.get<unknown, { count: number }>(
		`/projects/${projectId}/participants/count`,
	);
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

export const generateConversationTitle = async (conversationId: string) => {
	return api.post<unknown, { title: string }>(
		`/conversations/${conversationId}/generate-title`,
	);
};

export type VerificationTopicTranslation = {
	label: string;
};

export type VerificationTopicMetadata = {
	key: string;
	prompt?: string | null;
	icon?: string | null;
	sort?: number | null;
	is_custom?: boolean;
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

export type CreateCustomTopicPayload = {
	label: string;
	prompt: string;
	icon?: string;
	translations?: Record<string, string>;
};

export type UpdateCustomTopicPayload = {
	label?: string;
	prompt?: string;
	icon?: string;
	translations?: Record<string, string>;
};

export const createCustomVerificationTopic = async (
	projectId: string,
	payload: CreateCustomTopicPayload,
) => {
	return api.post<unknown, VerificationTopicsResponse>(
		`/verify/topics/${projectId}/custom`,
		payload,
	);
};

export const updateCustomVerificationTopic = async (
	projectId: string,
	topicKey: string,
	payload: UpdateCustomTopicPayload,
) => {
	return api.patch<unknown, VerificationTopicsResponse>(
		`/verify/topics/${projectId}/custom/${topicKey}`,
		payload,
	);
};

export const deleteCustomVerificationTopic = async (
	projectId: string,
	topicKey: string,
) => {
	return api.delete<unknown, VerificationTopicsResponse>(
		`/verify/topics/${projectId}/custom/${topicKey}`,
	);
};

export type VerificationArtifact = {
	id: string;
	approved_at?: string | null;
	date_created?: string | null;
	content: string;
	conversation_id: string;
	key: string;
	topic_label?: string | null;
	read_aloud_stream_url: string;
};

export type VerificationArtifactDetail = {
	id: string;
	content: string;
	date_created: string | null;
	approved_at?: string | null;
	key: string;
	topic_label?: string | null;
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

export const deleteTagById = async (projectId: string, tagId: string) => {
	return api.delete(`/projects/${projectId}/tags/${tagId}`);
};

export const deleteConversationTags = async (
	projectId: string,
	conversationId: string,
	tagIds: number[],
) => {
	return api.post(
		`/projects/${projectId}/conversations/${conversationId}/tags/delete`,
		{ tag_ids: tagIds },
	);
};

export const deleteChatById = async (chatId: string) => {
	try {
		const response = await api.delete(`/chats/${chatId}`);
		return response;
	} catch (error: any) {
		const message = error?.response?.data?.detail || "Failed to delete chat";
		throw new Error(message);
	}
};

export const deleteProjectById = async (projectId: string) => {
	try {
		const response = await api.delete(`/projects/${projectId}`);
		return response;
	} catch (error: any) {
		const message = error?.response?.data?.detail || "Failed to delete project";
		throw new Error(message);
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
	| "conversation.started"
	| "conversation.transcribed"
	| "conversation.summarized"
	| "report.generated";

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

export interface CopyableWebhook {
	id: string;
	name: string | null;
	url: string | null;
	events: WebhookEvent[] | null;
	project_id: string;
	project_name: string;
}

export const getProjectWebhooks = async (
	projectId: string,
): Promise<Webhook[]> => {
	const response = await api.get<unknown, Webhook[]>(
		`/projects/${projectId}/webhooks`,
	);
	return response;
};

export const getCopyableWebhooks = async (
	projectId: string,
): Promise<CopyableWebhook[]> => {
	const response = await api.get<unknown, CopyableWebhook[]>(
		`/projects/${projectId}/webhooks/copyable`,
	);
	return response;
};

export const createProjectWebhook = async (
	projectId: string,
	payload: WebhookCreatePayload,
): Promise<Webhook> => {
	const response = await api.post<unknown, Webhook>(
		`/projects/${projectId}/webhooks`,
		payload,
	);
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

// ── User Templates ──

export type PromptTemplateResponse = {
	id: string;
	title: string;
	content: string;
	icon: string | null;
	sort: number | null;
	is_public: boolean;
	description: string | null;
	tags: string[] | null;
	language: string | null;
	author_display_name: string | null;
	is_anonymous: boolean;
	use_count: number;
	star_count: number;
	copied_from: string | null;
	date_created: string | null;
	date_updated: string | null;
	// Workspace-scope (matrix v1.1). scope='user' = private template
	// (legacy). scope='workspace' = shared with every workspace member.
	scope: "user" | "workspace";
	workspace_id: string | null;
	// Derived server-side: true if the caller is allowed to edit this
	// template (creator for scope='user', or non-external workspace
	// member for scope='workspace').
	can_edit: boolean;
};

// -- Quick-Access Preferences --

export type QuickAccessPreference = {
	type: "static" | "user";
	id: string;
};

export const getPromptTemplates = async (
	workspaceId?: string | null,
): Promise<PromptTemplateResponse[]> => {
	const qs = workspaceId
		? `?workspace_id=${encodeURIComponent(workspaceId)}`
		: "";
	return api.get<unknown, PromptTemplateResponse[]>(
		`/templates/prompt-templates${qs}`,
	);
};

export const createPromptTemplate = async (payload: {
	title: string;
	content: string;
	icon?: string | null;
	// Default scope is 'user' — pass 'workspace' + workspace_id to
	// create a shared organisation template.
	scope?: "user" | "workspace";
	workspace_id?: string | null;
}): Promise<PromptTemplateResponse> => {
	return api.post<unknown, PromptTemplateResponse>(
		"/templates/prompt-templates",
		payload,
	);
};

export const updatePromptTemplate = async (
	templateId: string,
	payload: { title?: string; content?: string; icon?: string | null },
): Promise<PromptTemplateResponse> => {
	return api.patch<unknown, PromptTemplateResponse>(
		`/templates/prompt-templates/${templateId}`,
		payload,
	);
};

export const deletePromptTemplate = async (
	templateId: string,
): Promise<void> => {
	await api.delete(`/templates/prompt-templates/${templateId}`);
};

export const getQuickAccessPreferences = async (): Promise<
	QuickAccessPreference[]
> => {
	return api.get<unknown, QuickAccessPreference[]>("/templates/quick-access");
};

export const saveQuickAccessPreferences = async (
	preferences: QuickAccessPreference[],
): Promise<QuickAccessPreference[]> => {
	return api.put<unknown, QuickAccessPreference[]>(
		"/templates/quick-access",
		preferences,
	);
};

export const toggleAiSuggestions = async (
	hide_ai_suggestions: boolean,
): Promise<{ status: string; hide_ai_suggestions: boolean }> => {
	return api.patch<unknown, { status: string; hide_ai_suggestions: boolean }>(
		"/templates/ai-suggestions",
		{ hide_ai_suggestions },
	);
};
