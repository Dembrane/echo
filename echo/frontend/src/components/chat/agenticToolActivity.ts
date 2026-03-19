import { t } from "@lingui/core/macro";
import type { AgenticRunEvent } from "@/lib/api";

type AnyObject = Record<string, unknown>;

export type ToolActivityStatus = "running" | "completed" | "error";

export type ToolActivity = {
	id: string;
	toolName: string;
	status: ToolActivityStatus;
	sortSeq: number;
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
};

const buildHeadline = (toolName: string, context: ToolContext) => {
	switch (toolName) {
		case "get_project_scope":
			return t`Load project context`;
		case "listProjectConversations":
			return t`List project conversations`;
		case "findConvosByKeywords":
			return context.query
				? t`Search conversations for "${context.query}"`
				: t`Search conversations`;
		case "listConvoSummary":
			return t`Load conversation summary`;
		case "listConvoFullTranscript":
			return t`Load full transcript`;
		case "grepConvoSnippets":
			return context.query
				? t`Search transcript for "${context.query}"`
				: t`Search transcript`;
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

type ParsedToolEvent = Omit<ToolActivity, "id"> & {
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

	const query = firstString(
		input?.keywords,
		input?.query,
		outputContent?.query,
	);
	const context: ToolContext = {
		query,
	};

	const headline = buildHeadline(toolName, context);
	const rawInput = formatRaw(input ?? data?.input ?? payload?.input);
	const rawOutput = formatRaw(outputContent ?? output ?? data?.output);
	const rawError = formatRaw(error ?? data?.error ?? guardrail);

	return {
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

const takeLatestOpenIndex = (
	openToolIndexes: Map<string, number[]>,
	toolName: string,
) => {
	const openIndexes = openToolIndexes.get(toolName);
	if (!openIndexes || openIndexes.length === 0) return null;

	const index = openIndexes.pop() ?? null;
	if (openIndexes.length === 0) {
		openToolIndexes.delete(toolName);
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

		if (parsed.status === "running") {
			const nextIndex = activities.length;
			activities.push({
				...parsed,
				id: `tool-${parsed.toolName}-${parsed.seq}`,
			});
			openToolIndexes.set(parsed.toolName, [
				...(openToolIndexes.get(parsed.toolName) ?? []),
				nextIndex,
			]);
			continue;
		}

		const openIndex = takeLatestOpenIndex(openToolIndexes, parsed.toolName);
		if (openIndex === null) {
			activities.push({
				...parsed,
				id: `tool-${parsed.toolName}-${parsed.seq}`,
			});
			continue;
		}

		const existing = activities[openIndex];
		activities[openIndex] = {
			...existing,
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
