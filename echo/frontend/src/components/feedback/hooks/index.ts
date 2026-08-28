import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import posthog from "posthog-js";
import { API_BASE_URL } from "@/config";
import type { ReasonKey } from "../reasons";

export interface SubmitIssueReportInput {
	message: string;
	workspaceId?: string;
	projectId?: string;
	pageUrl?: string;
	locale?: string;
	userAgent?: string;
	sessionReplayUrl?: string;
	attachments: File[];
}

export interface IssueReportResponse {
	report_id: string;
	support_request_id: string;
	attachment_count: number;
}

/** Field names are the endpoint's contract; renaming any of them is a silent 422. */
export const buildIssueReportFormData = (
	input: SubmitIssueReportInput,
): FormData => {
	const fd = new FormData();
	fd.append("message", input.message);
	if (input.workspaceId) fd.append("workspace_id", input.workspaceId);
	if (input.projectId) fd.append("project_id", input.projectId);
	if (input.pageUrl) fd.append("page_url", input.pageUrl);
	if (input.locale) fd.append("locale", input.locale);
	if (input.userAgent) fd.append("user_agent", input.userAgent);
	if (input.sessionReplayUrl)
		fd.append("session_replay_url", input.sessionReplayUrl);
	for (const file of input.attachments) {
		fd.append("attachments", file);
	}
	return fd;
};

/** Carries the HTTP status so the modal can pick specific copy. */
export class IssueReportError extends Error {
	status: number;

	constructor(status: number, detail: string) {
		super(detail || "Request failed");
		this.name = "IssueReportError";
		this.status = status;
	}
}

const submitIssueReport = async (
	input: SubmitIssueReportInput,
): Promise<IssueReportResponse> => {
	const response = await fetch(`${API_BASE_URL}/v2/feedback/reports`, {
		body: buildIssueReportFormData(input),
		credentials: "include",
		method: "POST",
	});
	if (!response.ok) {
		const data = await response.json().catch(() => ({}));
		const detail = typeof data.detail === "string" ? data.detail : "";
		throw new IssueReportError(response.status, detail);
	}
	return response.json();
};

export const useSubmitIssueReportMutation = () =>
	useMutation({ mutationFn: submitIssueReport });

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Legacy chat streams client-side nanoid ids; only persisted uuids can be rated. */
export const isPersistedMessageId = (id: unknown): id is string =>
	typeof id === "string" && UUID_RE.test(id);

export type FeedbackTargetType =
	| "chat_message"
	| "report"
	| "conversation_summary"
	| "transcript";
export type FeedbackRating = "up" | "down";

export interface ResponseFeedback {
	id: string;
	target_type: FeedbackTargetType;
	target_id: string;
	rating: FeedbackRating;
	reasons: ReasonKey[];
	comment: string | null;
	date_created: string | null;
}

export interface SetResponseFeedbackInput {
	targetType: FeedbackTargetType;
	targetId: string;
	rating: FeedbackRating;
	reasons?: ReasonKey[];
	comment?: string;
	/** Same id list as the parent's useResponseFeedback, so the optimistic write hits its cache key. */
	allTargetIds?: string[];
}

export interface ClearResponseFeedbackInput {
	targetType: FeedbackTargetType;
	targetId: string;
	allTargetIds?: string[];
}

export const responseFeedbackQueryKey = (
	targetType: FeedbackTargetType,
	targetIds: string[],
) =>
	[
		"feedback",
		"responses",
		targetType,
		[...targetIds].sort().join(","),
	] as const;

const parseError = async (res: Response): Promise<Error> => {
	const data = await res.json().catch(() => ({}));
	const detail =
		typeof data?.detail === "string" ? data.detail : `HTTP ${res.status}`;
	const error = new Error(detail) as Error & { status?: number };
	error.status = res.status;
	return error;
};

const FEEDBACK_IDS_PER_REQUEST = 200;

export const fetchResponseFeedback = async (
	targetType: FeedbackTargetType,
	targetIds: string[],
): Promise<Record<string, ResponseFeedback>> => {
	const chunks: string[][] = [];
	for (let i = 0; i < targetIds.length; i += FEEDBACK_IDS_PER_REQUEST) {
		chunks.push(targetIds.slice(i, i + FEEDBACK_IDS_PER_REQUEST));
	}
	const pages = await Promise.all(
		chunks.map(async (chunk) => {
			const params = new URLSearchParams({
				target_ids: chunk.join(","),
				target_type: targetType,
			});
			const res = await fetch(
				`${API_BASE_URL}/v2/feedback/responses?${params}`,
				{ credentials: "include" },
			);
			if (!res.ok) throw await parseError(res);
			return (await res.json()) as ResponseFeedback[];
		}),
	);
	return Object.fromEntries(pages.flat().map((row) => [row.target_id, row]));
};

export const useResponseFeedback = (
	targetType: FeedbackTargetType,
	targetIds: string[],
) =>
	useQuery({
		enabled: targetIds.length > 0,
		queryFn: () => fetchResponseFeedback(targetType, targetIds),
		queryKey: responseFeedbackQueryKey(targetType, targetIds),
		staleTime: 60_000,
	});

export const applyOptimisticFeedback = (
	current: Record<string, ResponseFeedback> | undefined,
	input: Omit<SetResponseFeedbackInput, "allTargetIds">,
): Record<string, ResponseFeedback> => {
	const previous = current?.[input.targetId];
	return {
		...(current ?? {}),
		[input.targetId]: {
			comment: input.comment ?? previous?.comment ?? null,
			date_created: previous?.date_created ?? null,
			id: previous?.id ?? "optimistic",
			rating: input.rating,
			reasons: input.reasons ?? previous?.reasons ?? [],
			target_id: input.targetId,
			target_type: input.targetType,
		},
	};
};

export const removeOptimisticFeedback = (
	current: Record<string, ResponseFeedback> | undefined,
	targetId: string,
): Record<string, ResponseFeedback> => {
	const next = { ...(current ?? {}) };
	delete next[targetId];
	return next;
};

const setResponseFeedback = async (
	input: SetResponseFeedbackInput,
): Promise<ResponseFeedback> => {
	const res = await fetch(`${API_BASE_URL}/v2/feedback/responses`, {
		body: JSON.stringify({
			comment: input.comment,
			rating: input.rating,
			reasons: input.reasons ?? [],
			session_replay_url:
				posthog.get_session_replay_url?.({ withTimestamp: true }) ?? undefined,
			target_id: input.targetId,
			target_type: input.targetType,
		}),
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		method: "PUT",
	});
	if (!res.ok) throw await parseError(res);
	return res.json();
};

const clearResponseFeedback = async (
	input: ClearResponseFeedbackInput,
): Promise<void> => {
	const res = await fetch(
		`${API_BASE_URL}/v2/feedback/responses/${input.targetType}/${encodeURIComponent(input.targetId)}`,
		{ credentials: "include", method: "DELETE" },
	);
	if (!res.ok) throw await parseError(res);
};

interface FeedbackMutationContext {
	key: ReturnType<typeof responseFeedbackQueryKey>;
	previous: Record<string, ResponseFeedback> | undefined;
}

export const useSetResponseFeedbackMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<
		ResponseFeedback,
		Error,
		SetResponseFeedbackInput,
		FeedbackMutationContext | undefined
	>({
		mutationFn: setResponseFeedback,
		onError: (_error, _input, context) => {
			if (!context) return;
			queryClient.setQueryData(context.key, context.previous);
		},
		onMutate: async (input) => {
			const key = responseFeedbackQueryKey(
				input.targetType,
				input.allTargetIds ?? [input.targetId],
			);
			await queryClient.cancelQueries({ queryKey: key });
			const previous =
				queryClient.getQueryData<Record<string, ResponseFeedback>>(key);
			queryClient.setQueryData(key, applyOptimisticFeedback(previous, input));
			return { key, previous };
		},
		onSuccess: (row, input, context) => {
			if (!context) return;
			queryClient.setQueryData<Record<string, ResponseFeedback>>(
				context.key,
				(current) => ({ ...(current ?? {}), [input.targetId]: row }),
			);
		},
	});
};

export interface AdminResponseFeedbackRow extends ResponseFeedback {
	response_snapshot: string | null;
	context: {
		project_chat_id?: string;
		chat_mode?: string | null;
		prompt?: string;
		session_replay_url?: string;
	};
	project_id: string | null;
	project_name: string | null;
	workspace_id: string | null;
	workspace_name: string | null;
	org_name: string | null;
	user_name: string | null;
	user_email: string | null;
}

export interface AdminResponseFeedbackFilters {
	rating?: FeedbackRating;
	targetType?: FeedbackTargetType;
	reason?: ReasonKey;
	chatMode?: "overview" | "deep_dive" | "agentic";
	dateFrom?: string;
	dateTo?: string;
	page: number;
	limit: number;
}

export const useAdminResponseFeedback = (
	filters: AdminResponseFeedbackFilters,
) =>
	useQuery({
		queryFn: async () => {
			const params = new URLSearchParams({
				limit: String(filters.limit),
				page: String(filters.page),
			});
			if (filters.rating) params.set("rating", filters.rating);
			if (filters.targetType) params.set("target_type", filters.targetType);
			if (filters.reason) params.set("reason", filters.reason);
			if (filters.chatMode) params.set("chat_mode", filters.chatMode);
			if (filters.dateFrom) params.set("date_from", filters.dateFrom);
			if (filters.dateTo) params.set("date_to", filters.dateTo);
			const res = await fetch(
				`${API_BASE_URL}/v2/feedback/responses/admin?${params}`,
				{ credentials: "include" },
			);
			if (!res.ok) throw await parseError(res);
			return (await res.json()) as {
				items: AdminResponseFeedbackRow[];
				page: number;
				limit: number;
				total: number;
			};
		},
		queryKey: ["feedback", "responses", "admin", filters],
	});

export const useClearResponseFeedbackMutation = () => {
	const queryClient = useQueryClient();
	return useMutation<
		void,
		Error,
		ClearResponseFeedbackInput,
		FeedbackMutationContext | undefined
	>({
		mutationFn: clearResponseFeedback,
		onError: (_error, _input, context) => {
			if (!context) return;
			queryClient.setQueryData(context.key, context.previous);
		},
		onMutate: async (input) => {
			const key = responseFeedbackQueryKey(
				input.targetType,
				input.allTargetIds ?? [input.targetId],
			);
			await queryClient.cancelQueries({ queryKey: key });
			const previous =
				queryClient.getQueryData<Record<string, ResponseFeedback>>(key);
			queryClient.setQueryData(
				key,
				removeOptimisticFeedback(previous, input.targetId),
			);
			return { key, previous };
		},
	});
};
