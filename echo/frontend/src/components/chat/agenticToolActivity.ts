import type { AgenticRunEvent } from "@/lib/api";

type AnyObject = Record<string, unknown>;

export type ToolActivityStatus = "running" | "completed" | "error";

export type ToolActivity = {
	id: string;
	toolName: string;
	status: ToolActivityStatus;
	headline: string;
	summaryLines: string[];
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

const asNumber = (value: unknown): number | null => {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const firstString = (...values: unknown[]): string | null => {
	for (const value of values) {
		const normalized = asString(value);
		if (normalized) return normalized;
	}
	return null;
};

const firstNumber = (...values: unknown[]): number | null => {
	for (const value of values) {
		const normalized = asNumber(value);
		if (normalized !== null) return normalized;
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

	if (!spaced) return "Tool";
	return `${spaced[0]?.toUpperCase() ?? ""}${spaced.slice(1)}`;
};

const normalizeErrorRepr = (repr: string) => {
	const trimmed = repr.trim();
	const match = trimmed.match(/^[A-Za-z_]\w*\((.*)\)$/);
	if (!match) return trimmed;
	return match[1].replace(/^['"]|['"]$/g, "");
};

type ToolContext = {
	query: string | null;
	limit: number | null;
	count: number | null;
	conversationId: string | null;
	participantName: string | null;
	projectId: string | null;
	guardrailMessage: string | null;
	errorMessage: string | null;
	transcriptCharCount: number | null;
};

const buildHeadline = (
	toolName: string,
	status: ToolActivityStatus,
	context: ToolContext,
) => {
	switch (toolName) {
		case "get_project_scope":
			if (status === "running") return "Getting project information...";
			if (status === "completed") return "Project information ready";
			return "Could not get project information";
		case "listProjectConversations":
			if (status === "running") return "Listing project conversations...";
			if (status === "completed" && context.count !== null) {
				return `Listed ${context.count} conversations`;
			}
			if (status === "completed") return "Project conversations listed";
			return "Could not list project conversations";
		case "findConvosByKeywords":
			if (status === "running" && context.query) {
				return `Searching conversations for "${context.query}"...`;
			}
			if (status === "running") return "Searching conversations by keywords...";
			if (status === "completed" && context.count === 0 && context.query) {
				return `No matching conversations for "${context.query}"`;
			}
			if (status === "completed" && context.count !== null) {
				return `Found ${context.count} matching conversations`;
			}
			if (status === "completed") return "Conversation search complete";
			if (context.query) return `Search failed for "${context.query}"`;
			return "Conversation search failed";
		case "listConvoSummary":
			if (status === "running") return "Getting conversation summary...";
			if (status === "completed") return "Conversation summary ready";
			return "Could not get conversation summary";
		case "listConvoFullTranscript":
			if (status === "running") return "Loading full transcript...";
			if (status === "completed") return "Transcript ready";
			return "Could not load transcript";
		case "grepConvoSnippets":
			if (status === "running" && context.query) {
				return `Searching transcript for "${context.query}"...`;
			}
			if (status === "running") return "Searching transcript snippets...";
			if (status === "completed" && context.count === 0) {
				return "No matching snippets found";
			}
			if (status === "completed" && context.count !== null) {
				return `Found ${context.count} matching snippets`;
			}
			if (status === "completed") return "Transcript snippet search complete";
			if (context.query) return `Snippet search failed for "${context.query}"`;
			return "Snippet search failed";
		default: {
			const humanized = humanizeToolName(toolName);
			if (status === "running") return `Running ${humanized}...`;
			if (status === "completed") return `Finished ${humanized}`;
			return `${humanized} failed`;
		}
	}
};

const buildSummaryLines = (
	toolName: string,
	status: ToolActivityStatus,
	context: ToolContext,
) => {
	const lines: string[] = [];

	if (context.query) lines.push(`Query: ${context.query}`);
	if (context.limit !== null) lines.push(`Limit: ${context.limit}`);
	if (context.count !== null) lines.push(`Count: ${context.count}`);
	if (context.conversationId) lines.push(`Conversation: ${context.conversationId}`);
	if (context.participantName) lines.push(`Participant: ${context.participantName}`);
	if (context.projectId) lines.push(`Project: ${context.projectId}`);
	if (context.transcriptCharCount !== null && status === "completed") {
		lines.push(`Transcript length: ${context.transcriptCharCount} chars`);
	}
	if (context.guardrailMessage) lines.push(context.guardrailMessage);
	if (context.errorMessage) lines.push(`Error: ${context.errorMessage}`);

	// Keep summaries concise for tools with noisy payloads.
	if (toolName === "listProjectConversations" && status === "completed") {
		return lines.filter((line) => line.startsWith("Count:") || line.startsWith("Project:"));
	}

	if (toolName === "get_project_scope" && status === "completed") {
		return lines.filter((line) => line.startsWith("Project:"));
	}

	return lines;
};

const dedupeLines = (lines: string[]) => {
	const seen = new Set<string>();
	const deduped: string[] = [];
	for (const line of lines) {
		if (!line || seen.has(line)) continue;
		seen.add(line);
		deduped.push(line);
	}
	return deduped;
};

const toStatus = (eventType: string): ToolActivityStatus | null => {
	if (eventType === "on_tool_start") return "running";
	if (eventType === "on_tool_end") return "completed";
	if (eventType === "on_tool_error") return "error";
	return null;
};

export const extractTopLevelToolActivity = (
	event: AgenticRunEvent,
): ToolActivity[] => {
	const status = toStatus(event.event_type);
	if (!status) return [];

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

	const query = firstString(input?.keywords, input?.query, outputContent?.query);
	const limit = firstNumber(input?.limit);
	const count =
		firstNumber(outputContent?.count) ??
		(Array.isArray(outputContent?.conversations)
			? outputContent.conversations.length
			: null) ??
		(Array.isArray(outputContent?.matches) ? outputContent.matches.length : null);
	const conversationId = firstString(
		input?.conversation_id,
		outputContent?.conversation_id,
	);
	const participantName = firstString(outputContent?.participant_name);
	const projectId = firstString(outputContent?.project_id);
	const guardrailMessage = firstString(guardrail?.message);
	const transcript = firstString(outputContent?.transcript);
	const transcriptCharCount = transcript ? transcript.length : null;
	const errorMessage =
		firstString(error?.message, data?.message, payload?.message) ??
		(() => {
			const repr = firstString(error?.repr);
			return repr ? normalizeErrorRepr(repr) : null;
		})();

	const context: ToolContext = {
		conversationId,
		count,
		errorMessage,
		guardrailMessage,
		limit,
		participantName,
		projectId,
		query,
		transcriptCharCount,
	};

	const headline = buildHeadline(toolName, status, context);
	const summaryLines = dedupeLines(buildSummaryLines(toolName, status, context));
	const rawInput = formatRaw(input ?? data?.input ?? payload?.input);
	const rawOutput = formatRaw(outputContent ?? output ?? data?.output);
	const rawError = formatRaw(error ?? data?.error);

	return [
		{
			headline,
			id: `tool-event-${event.seq}`,
			rawError,
			rawInput,
			rawOutput,
			status,
			summaryLines,
			toolName,
		},
	];
};
