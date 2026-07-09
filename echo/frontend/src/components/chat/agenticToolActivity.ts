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
		case "navigateTo":
			return t`Preparing a navigation shortcut`;
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
		// Old and new names both map here so replayed history keeps its headline.
		case "findConversationsByKeywords":
		case "findConvosByKeywords":
			return context.query
				? t`Searching conversations for "${context.query}"`
				: t`Searching conversations`;
		case "listConversationSummary":
		case "listConvoSummary":
			return context.participantName
				? t`Reading ${context.participantName}'s summary`
				: t`Reading a conversation summary`;
		case "listConversationFullTranscript":
		case "listConvoFullTranscript":
			return context.participantName
				? t`Reading ${context.participantName}'s transcript`
				: t`Reading a transcript`;
		case "grepConversationSnippets":
		case "grepConvoSnippets":
			return context.query
				? t`Searching transcripts for "${context.query}"`
				: t`Searching transcripts`;
		case "editProjectTags":
			return t`Updating project tags`;
		case "noteInsight":
		case "recordInsight":
			return t`Noting this for the dembrane team`;
		case "editInsight":
			return t`Updating a note for the dembrane team`;
		case "retractInsight":
			return t`Retracting a note for the dembrane team`;
		case "amendMemory":
			return t`Updating a saved memory`;
		case "forgetMemory":
			return t`Forgetting a saved memory`;
		case "reachOutToDembraneSupport":
		case "reachOutToDembrane":
			return t`Logging this with the dembrane team`;
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
	tabs?: Array<Record<string, unknown>> | null;
	cadence_minutes?: number | null;
	expires_at?: string | null;
	target_canvas_id?: string | null;
	target_canvas_name?: string | null;
	proposed_at?: string | null;
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
			tabs: Array.isArray(payload.tabs)
				? (payload.tabs.filter(
						(tab: unknown) => tab && typeof tab === "object",
					) as Array<Record<string, unknown>>)
				: null,
			name,
			proposed_at: activity.timestamp,
			projectId: String(payload.project_id ?? ""),
			target_canvas_id:
				typeof payload.target_canvas_id === "string"
					? payload.target_canvas_id
					: null,
			target_canvas_name:
				typeof payload.target_canvas_name === "string"
					? payload.target_canvas_name
					: null,
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

export type ParsedNavigationSuggestion = {
	projectId: string;
	page:
		| "overview"
		| "chats"
		| "monitor"
		| "library"
		| "host-guide"
		| "report"
		| "conversations"
		| "settings"
		| "portal-editor";
	entityId: string | null;
};

const NAVIGATION_PAGE_KEYS = new Set<ParsedNavigationSuggestion["page"]>([
	"overview",
	"chats",
	"monitor",
	"library",
	"host-guide",
	"report",
	"conversations",
	"settings",
	"portal-editor",
]);

export type AgentInsightKind =
	| "capability_gap"
	| "friction"
	| "wish"
	| "praise";

/** How the host last touched this insight: freshly noted, amended by id, or
 * withdrawn. The card mutes for "retracted". */
export type InsightNoteMode = "noted" | "edited" | "retracted";

export type ParsedInsightNote = {
	kind: AgentInsightKind;
	content: string;
	suggestedCapability: string | null;
	insightId: string | null;
	mode: InsightNoteMode;
	reason: string | null;
};

const INSIGHT_KINDS = new Set<AgentInsightKind>([
	"capability_gap",
	"friction",
	"wish",
	"praise",
]);

const INSIGHT_MODES = new Set<InsightNoteMode>([
	"noted",
	"edited",
	"retracted",
]);

// noteInsight (and its legacy name recordInsight) note a fresh insight;
// editInsight and retractInsight amend one BY ID. All four write the same
// agent_insight_note payload shape, and old chats must still render their card,
// so we accept every one of these tool names.
const INSIGHT_TOOL_NAMES = new Set<string>([
	"noteInsight",
	"recordInsight",
	"editInsight",
	"retractInsight",
]);

/** Returns the structured note when a completed tool activity is a noteInsight,
 * editInsight, retractInsight (or legacy recordInsight) result, else null.
 * Legacy payloads without a `mode` fall back to "noted". */
export const parseInsightNote = (
	activity: ToolActivity,
): ParsedInsightNote | null => {
	if (!INSIGHT_TOOL_NAMES.has(activity.toolName)) return null;
	if (activity.status !== "completed" || !activity.rawOutput) return null;
	try {
		const payload = JSON.parse(activity.rawOutput);
		if (payload?.type !== "agent_insight_note") return null;
		const kind = String(payload.insight_kind ?? "").trim();
		if (!INSIGHT_KINDS.has(kind as AgentInsightKind)) return null;
		const content = String(payload.content ?? "").trim();
		if (!content) return null;
		const suggestedCapability =
			typeof payload.suggested_capability === "string" &&
			payload.suggested_capability.trim()
				? payload.suggested_capability.trim()
				: null;
		const rawMode = String(payload.mode ?? "noted").trim();
		const mode: InsightNoteMode = INSIGHT_MODES.has(rawMode as InsightNoteMode)
			? (rawMode as InsightNoteMode)
			: "noted";
		const insightId =
			typeof payload.agent_insight_id === "string" &&
			payload.agent_insight_id.trim()
				? payload.agent_insight_id.trim()
				: null;
		const reason =
			typeof payload.reason === "string" && payload.reason.trim()
				? payload.reason.trim()
				: null;
		return {
			content,
			insightId,
			kind: kind as AgentInsightKind,
			mode,
			reason,
			suggestedCapability,
		};
	} catch {
		return null;
	}
};

/** Returns the structured suggestion when a completed tool activity is a
 * navigateTo result, else null. */
export const parseNavigationSuggestion = (
	activity: ToolActivity,
): ParsedNavigationSuggestion | null => {
	if (activity.toolName !== "navigateTo") return null;
	if (activity.status !== "completed" || !activity.rawOutput) return null;
	try {
		const payload = JSON.parse(activity.rawOutput);
		if (payload?.type !== "navigation_suggestion") return null;
		const page = String(payload.page ?? "").trim();
		if (!NAVIGATION_PAGE_KEYS.has(page as ParsedNavigationSuggestion["page"]))
			return null;
		const entityId =
			typeof payload.entity_id === "string" && payload.entity_id.trim()
				? payload.entity_id.trim()
				: null;
		return {
			entityId,
			page: page as ParsedNavigationSuggestion["page"],
			projectId: String(payload.project_id ?? ""),
		};
	} catch {
		return null;
	}
};
