import { t } from "@lingui/core/macro";
import type { AgenticRunEvent } from "@/lib/api";

type AnyObject = Record<string, unknown>;

export type ToolActivityStatus = "running" | "completed" | "error";

export type ToolActivity = {
	id: string;
	toolName: string;
	status: ToolActivityStatus;
	sortSeq: number;
	/** Seq of the start event and of the latest close event. Two activities
	 * overlapped (ran at the same time) when one starts before the other ends. */
	startSeq: number;
	endSeq: number;
	timestamp: string;
	headline: string;
	rawInput: string | null;
	rawOutput: string | null;
	rawError: string | null;
};

const MAX_RAW_LENGTH = 4000;

const asObject = (value: unknown): AnyObject | null => {
	if (value && typeof value === "object") return value as AnyObject;
	return null;
};

const asString = (value: unknown): string | null => {
	return typeof value === "string" && value.trim() ? value.trim() : null;
};

const firstString = (...values: unknown[]): string | null => {
	for (const value of values) {
		const normalized = asString(value);
		if (normalized) return normalized;
	}
	return null;
};

const parseObjectFromUnknown = (value: unknown): AnyObject | null => {
	if (value && typeof value === "object") return value as AnyObject;
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		return asObject(parsed);
	} catch {
		return null;
	}
};

const truncate = (value: string, maxLength = MAX_RAW_LENGTH) => {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength)}...`;
};

const formatRaw = (value: unknown): string | null => {
	if (value === null || value === undefined) return null;
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) return null;
		return truncate(trimmed);
	}
	if (typeof value === "object") {
		try {
			return truncate(JSON.stringify(value, null, 2));
		} catch {
			return truncate(String(value));
		}
	}
	return truncate(String(value));
};

const humanizeToolName = (toolName: string) => {
	const spaced = toolName
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.trim();

	if (!spaced) return t`Tool`;
	if (spaced.toLowerCase() === "tool") return t`Tool`;
	return `${spaced[0]?.toUpperCase() ?? ""}${spaced.slice(1)}`;
};

type ToolContext = {
	query: string | null;
	participantName: string | null;
};

// Gerund phrasing throughout: these lines double as the live status text in
// the "working" pill, so they must read as something happening now.
const buildHeadline = (toolName: string, context: ToolContext) => {
	switch (toolName) {
		case "proposeProjectUpdate":
			return t`Suggesting project changes`;
		case "proposeCustomVerificationTopic":
			return t`Suggesting a verification prompt`;
		case "proposeCanvas":
			return t`Suggesting a canvas`;
		case "proposeGoal":
			return t`Suggesting a project goal`;
		case "getProjectSettings":
			return t`Reading project settings`;
		case "grepDocs":
			return t`Searching the documentation`;
		case "readDoc":
			return t`Reading the documentation`;
		case "readSkill":
			return t`Reading a skill`;
		case "listDocs":
			return t`Listing documentation pages`;
		case "get_project_scope":
			return t`Reading project context`;
		case "listProjectConversations":
			return t`Listing conversations`;
		case "getLiveConversationStatus":
			return t`Checking live conversations`;
		case "findConvosByKeywords":
			return context.query
				? t`Searching conversations for "${context.query}"`
				: t`Searching conversations`;
		case "listConvoSummary":
			return context.participantName
				? t`Reading ${context.participantName}'s summary`
				: t`Reading a conversation summary`;
		case "listConvoFullTranscript":
			return context.participantName
				? t`Reading ${context.participantName}'s transcript`
				: t`Reading a transcript`;
		case "grepConvoSnippets":
			return context.query
				? t`Searching transcripts for "${context.query}"`
				: t`Searching transcripts`;
		default: {
			return humanizeToolName(toolName);
		}
	}
};

const toStatus = (eventType: string): ToolActivityStatus | null => {
	if (eventType === "on_tool_start") return "running";
	if (eventType === "on_tool_end") return "completed";
	if (eventType === "on_tool_error") return "error";
	return null;
};

type ParsedToolEvent = Omit<ToolActivity, "id" | "startSeq" | "endSeq"> & {
	callId: string | null;
	seq: number;
};

const parseToolEvent = (event: AgenticRunEvent): ParsedToolEvent | null => {
	const status = toStatus(event.event_type);
	if (!status) return null;

	const payload = asObject(event.payload);
	const data = asObject(payload?.data);
	const output = asObject(data?.output) ?? asObject(payload?.output);
	const outputKwargs = asObject(output?.kwargs);
	const outputContent = parseObjectFromUnknown(outputKwargs?.content);
	const input =
		asObject(data?.input) ??
		parseObjectFromUnknown(payload?.input) ??
		parseObjectFromUnknown(payload?.args);
	const error = asObject(data?.error) ?? asObject(payload?.error);
	const guardrail = asObject(outputContent?.guardrail);

	const toolName =
		firstString(
			payload?.name,
			payload?.tool_name,
			payload?.toolName,
			data?.name,
			outputKwargs?.name,
		) ?? "tool";
	const callId = firstString(
		payload?.run_id,
		payload?.runId,
		payload?.tool_call_id,
		payload?.toolCallId,
		payload?.call_id,
		payload?.callId,
		data?.run_id,
		data?.runId,
		data?.tool_call_id,
		data?.toolCallId,
		data?.call_id,
		data?.callId,
		outputKwargs?.run_id,
		outputKwargs?.runId,
		outputKwargs?.tool_call_id,
		outputKwargs?.toolCallId,
		outputKwargs?.call_id,
		outputKwargs?.callId,
		payload?.id,
		data?.id,
	);

	const query = firstString(
		input?.keywords,
		input?.query,
		outputContent?.query,
	);
	// Tool outputs carry participant_name for conversation reads; the end
	// event's headline wins in the merge below, so the name appears as soon
	// as the read completes.
	const participantName = firstString(
		outputContent?.participant_name,
		input?.participant_name,
	);
	const context: ToolContext = {
		participantName,
		query,
	};

	const headline = buildHeadline(toolName, context);
	const rawInput = formatRaw(input ?? data?.input ?? payload?.input);
	const rawOutput = formatRaw(outputContent ?? output ?? data?.output);
	const rawError = formatRaw(error ?? data?.error ?? guardrail);

	return {
		callId,
		headline,
		rawError,
		rawInput,
		rawOutput,
		seq: event.seq,
		sortSeq: event.seq,
		status,
		timestamp: event.timestamp,
		toolName,
	};
};

const getToolPairingKey = (parsed: ParsedToolEvent) =>
	parsed.callId ? `call:${parsed.callId}` : `tool:${parsed.toolName}`;

const getToolActivityId = (parsed: ParsedToolEvent) =>
	parsed.callId
		? `tool-${parsed.toolName}-${parsed.callId}`
		: `tool-${parsed.toolName}-${parsed.seq}`;

const takeLatestOpenIndex = (
	openToolIndexes: Map<string, number[]>,
	pairingKey: string,
) => {
	const openIndexes = openToolIndexes.get(pairingKey);
	if (!openIndexes || openIndexes.length === 0) return null;

	const index = openIndexes.pop() ?? null;
	if (openIndexes.length === 0) {
		openToolIndexes.delete(pairingKey);
	}
	return index;
};

export const extractTopLevelToolActivity = (
	events: AgenticRunEvent[],
): ToolActivity[] => {
	const activities: ToolActivity[] = [];
	const openToolIndexes = new Map<string, number[]>();

	for (const event of events) {
		const parsed = parseToolEvent(event);
		if (!parsed) continue;
		const pairingKey = getToolPairingKey(parsed);

		if (parsed.status === "running") {
			const nextIndex = activities.length;
			activities.push({
				...parsed,
				endSeq: parsed.seq,
				id: getToolActivityId(parsed),
				startSeq: parsed.seq,
			});
			openToolIndexes.set(pairingKey, [
				...(openToolIndexes.get(pairingKey) ?? []),
				nextIndex,
			]);
			continue;
		}

		const openIndex = takeLatestOpenIndex(openToolIndexes, pairingKey);
		if (openIndex === null) {
			activities.push({
				...parsed,
				endSeq: parsed.seq,
				id: getToolActivityId(parsed),
				startSeq: parsed.seq,
			});
			continue;
		}

		const existing = activities[openIndex];
		activities[openIndex] = {
			...existing,
			endSeq: parsed.seq,
			headline: parsed.headline || existing.headline,
			rawError: parsed.rawError ?? existing.rawError,
			rawInput: existing.rawInput ?? parsed.rawInput,
			rawOutput: parsed.rawOutput ?? existing.rawOutput,
			status: parsed.status,
			timestamp: parsed.timestamp,
		};
	}

	return activities;
};

export type ParsedProjectUpdateSuggestion = {
	projectId: string;
	summary: string;
	changes: Array<{
		field: string;
		current: unknown;
		proposed: unknown;
		reason: string;
	}>;
};

/** Returns the structured suggestion when a completed tool activity is a
 * proposeProjectUpdate result, else null. */
export const parseProjectUpdateSuggestion = (
	activity: ToolActivity,
): ParsedProjectUpdateSuggestion | null => {
	if (activity.toolName !== "proposeProjectUpdate") return null;
	if (activity.status !== "completed" || !activity.rawOutput) return null;
	try {
		const payload = JSON.parse(activity.rawOutput);
		if (payload?.kind !== "project_update_suggestion") return null;
		if (!Array.isArray(payload.changes) || payload.changes.length === 0)
			return null;
		return {
			changes: payload.changes.map((change: Record<string, unknown>) => ({
				current: change.current,
				field: String(change.field ?? ""),
				proposed: change.proposed,
				reason: String(change.reason ?? ""),
			})),
			projectId: String(payload.project_id ?? ""),
			summary: String(payload.summary ?? ""),
		};
	} catch {
		return null;
	}
};

export type ParsedCustomVerificationTopicSuggestion = {
	projectId: string;
	label: string;
	prompt: string;
	reason: string;
};

/** Returns the structured suggestion when a completed tool activity is a
 * proposeCustomVerificationTopic result, else null. */
export const parseCustomVerificationTopicSuggestion = (
	activity: ToolActivity,
): ParsedCustomVerificationTopicSuggestion | null => {
	if (activity.toolName !== "proposeCustomVerificationTopic") return null;
	if (activity.status !== "completed" || !activity.rawOutput) return null;
	try {
		const payload = JSON.parse(activity.rawOutput);
		if (payload?.kind !== "custom_verification_topic_suggestion") return null;
		const label = String(payload.label ?? "").trim();
		const prompt = String(payload.prompt ?? "").trim();
		if (!label || !prompt) return null;
		return {
			label,
			projectId: String(payload.project_id ?? ""),
			prompt,
			reason: String(payload.reason ?? ""),
		};
	} catch {
		return null;
	}
};

export type ParsedCanvasSuggestion = {
	projectId: string;
	name: string;
	brief: string;
	gather_spec?: Record<string, unknown> | null;
	cadence_minutes?: number | null;
	expires_at?: string | null;
};

/** Returns the structured suggestion when a completed tool activity is a
 * proposeCanvas result, else null. */
export const parseCanvasSuggestion = (
	activity: ToolActivity,
): ParsedCanvasSuggestion | null => {
	if (activity.toolName !== "proposeCanvas") return null;
	if (activity.status !== "completed" || !activity.rawOutput) return null;
	try {
		const payload = JSON.parse(activity.rawOutput);
		if (payload?.type !== "canvas_proposal") return null;
		const name = String(payload.name ?? "").trim();
		const brief = String(payload.brief ?? "").trim();
		if (!name || !brief) return null;
		return {
			brief,
			cadence_minutes:
				typeof payload.cadence_minutes === "number"
					? payload.cadence_minutes
					: null,
			expires_at:
				typeof payload.expires_at === "string" ? payload.expires_at : null,
			gather_spec:
				payload.gather_spec && typeof payload.gather_spec === "object"
					? (payload.gather_spec as Record<string, unknown>)
					: null,
			name,
			projectId: String(payload.project_id ?? ""),
		};
	} catch {
		return null;
	}
};

export type ParsedGoalSuggestion = {
	projectId: string;
	content: string;
};

/** Returns the structured suggestion when a completed tool activity is a
 * proposeGoal result, else null. */
export const parseGoalSuggestion = (
	activity: ToolActivity,
): ParsedGoalSuggestion | null => {
	if (activity.toolName !== "proposeGoal") return null;
	if (activity.status !== "completed" || !activity.rawOutput) return null;
	try {
		const payload = JSON.parse(activity.rawOutput);
		if (payload?.type !== "goal_proposal") return null;
		const content = String(payload.content ?? "").trim();
		if (!content) return null;
		return {
			content,
			projectId: String(payload.project_id ?? ""),
		};
	} catch {
		return null;
	}
};
