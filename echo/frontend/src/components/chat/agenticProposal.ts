import type { AgenticRunEvent } from "@/lib/api";

type AnyObject = Record<string, unknown>;

export type ProposalEdit = {
	field: string;
	label: string;
	proposedValue: string;
};

export type AgenticProposal = {
	id: string;
	proposalType: string;
	projectId: string | null;
	title: string;
	reason: string | null;
	edits: ProposalEdit[];
};

const asObject = (value: unknown): AnyObject | null => {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as AnyObject;
	}
	return null;
};

const parseObjectFromUnknown = (value: unknown): AnyObject | null => {
	const direct = asObject(value);
	if (direct) return direct;
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	try {
		return asObject(JSON.parse(trimmed));
	} catch {
		return null;
	}
};

const asString = (value: unknown): string | null =>
	typeof value === "string" && value.trim() ? value.trim() : null;

// A proposal rides the tool's return value on the `on_tool_end` event, the same
// path agenticToolActivity reads. We detect `kind === "proposal"` and render an
// interactive diff card instead of a passive tool-activity card.
export const extractProposal = (
	event: AgenticRunEvent,
): AgenticProposal | null => {
	if (event.event_type !== "on_tool_end") return null;

	const payload = asObject(event.payload);
	const data = asObject(payload?.data);
	const output = asObject(data?.output) ?? asObject(payload?.output);
	const outputKwargs = asObject(output?.kwargs);
	const content =
		parseObjectFromUnknown(outputKwargs?.content) ??
		parseObjectFromUnknown(data?.output) ??
		parseObjectFromUnknown(payload?.output);

	if (!content || content.kind !== "proposal") return null;

	const rawEdits = Array.isArray(content.edits) ? content.edits : [];
	const edits: ProposalEdit[] = [];
	for (const rawEdit of rawEdits) {
		const edit = asObject(rawEdit);
		const field = asString(edit?.field);
		const proposedValue =
			typeof edit?.proposed_value === "string" ? edit.proposed_value : null;
		if (!field || proposedValue === null) continue;
		edits.push({
			field,
			label: asString(edit?.label) ?? field,
			proposedValue,
		});
	}

	if (edits.length === 0) return null;

	const target = asObject(content.target);

	return {
		edits,
		id: `proposal-${event.seq}`,
		projectId: asString(target?.project_id),
		proposalType: asString(content.proposal_type) ?? "unknown",
		reason: asString(content.reason),
		title: asString(content.title) ?? "Proposed change",
	};
};
