import type { AgenticRunEvent } from "@/lib/api";

/**
 * The plan the agent shows the host, rebuilt from its tool events.
 *
 * Mirrors sam's Slack plan block: the first `ack` that carries a plan seeds the
 * steps, `updatePlan` ticks them off (its `done` counts finished leading steps
 * and its `note` is what the finished step found), and the final answer sweeps
 * the plan complete. A turn that fails leaves the running step marked stopped.
 */

export type PlanStepStatus = "done" | "in_progress" | "pending" | "stopped";

export type PlanStep = {
	title: string;
	status: PlanStepStatus;
	note: string | null;
};

export type AgenticPlan = {
	id: string;
	/** Where the plan sits in the thread: just after the ack message. */
	sortSeq: number;
	steps: PlanStep[];
	/** The turn is still running: the plan is live. */
	live: boolean;
};

type TurnOutcome = "live" | "finished" | "stopped";

type AnyObject = Record<string, unknown>;

const asObject = (value: unknown): AnyObject | null =>
	value && typeof value === "object" ? (value as AnyObject) : null;

const parseInput = (value: unknown): AnyObject | null => {
	const direct = asObject(value);
	if (direct) return direct;
	if (typeof value !== "string") return null;
	try {
		return asObject(JSON.parse(value));
	} catch {
		return null;
	}
};

const toStepTitles = (value: unknown): string[] =>
	Array.isArray(value)
		? value
				.filter((step): step is string => typeof step === "string")
				.map((step) => step.trim())
				.filter(Boolean)
		: [];

const toolStart = (
	event: AgenticRunEvent,
): { name: string; input: AnyObject } | null => {
	if (event.event_type !== "on_tool_start") return null;
	const payload = asObject(event.payload);
	const data = asObject(payload?.data);
	const name = typeof payload?.name === "string" ? payload.name : null;
	const input = parseInput(data?.input ?? payload?.input);
	if (!name || !input) return null;
	return { input, name };
};

type PlanDraft = {
	id: string;
	ackSeq: number;
	anchorSeq: number | null;
	titles: string[];
	done: number;
	notes: (string | null)[];
};

const TERMINAL_FAILURES = new Set(["run.failed", "run.timeout"]);

export const derivePlans = (
	events: AgenticRunEvent[],
	latestRunStatus: string | null,
): AgenticPlan[] => {
	const sorted = [...events].sort((a, b) => a.seq - b.seq);
	const plans: { draft: PlanDraft; outcome: TurnOutcome }[] = [];
	let current: PlanDraft | null = null;
	let turnFailed = false;

	const closeTurn = (outcome: TurnOutcome) => {
		if (current) plans.push({ draft: current, outcome });
		current = null;
		turnFailed = false;
	};

	for (const event of sorted) {
		if (event.event_type === "user.message") {
			closeTurn(turnFailed ? "stopped" : "finished");
			continue;
		}
		if (TERMINAL_FAILURES.has(event.event_type)) {
			turnFailed = true;
			continue;
		}
		const draft = current as PlanDraft | null;
		if (
			draft &&
			draft.anchorSeq === null &&
			event.event_type === "assistant.message" &&
			event.seq > draft.ackSeq
		) {
			draft.anchorSeq = event.seq;
		}

		const start = toolStart(event);
		if (!start) continue;

		if (start.name === "ack") {
			const titles = toStepTitles(start.input.plan);
			if (titles.length === 0) continue;
			if (draft) {
				// A revised plan: finished steps that kept their titles stay done.
				let keptDone = 0;
				while (
					keptDone < draft.done &&
					keptDone < titles.length &&
					draft.titles[keptDone] === titles[keptDone]
				) {
					keptDone += 1;
				}
				draft.titles = titles;
				draft.done = keptDone;
				draft.notes = titles.map((_, index) =>
					index < keptDone ? (draft.notes[index] ?? null) : null,
				);
				continue;
			}
			current = {
				ackSeq: event.seq,
				anchorSeq: null,
				done: 0,
				id: `plan-${event.seq}`,
				notes: titles.map(() => null),
				titles,
			};
			continue;
		}

		if (start.name === "updatePlan" && draft) {
			const titles = toStepTitles(start.input.steps);
			if (titles.length === 0) continue;
			const rawDone = Number(start.input.done);
			const done = Number.isFinite(rawDone)
				? Math.max(0, Math.min(Math.trunc(rawDone), titles.length))
				: draft.done;
			const notes = titles.map((title, index) =>
				draft.titles[index] === title ? (draft.notes[index] ?? null) : null,
			);
			const note =
				typeof start.input.note === "string" ? start.input.note.trim() : "";
			if (note && done > 0) notes[done - 1] = note;
			draft.titles = titles;
			draft.done = done;
			draft.notes = notes;
		}
	}

	if (current) {
		const status = latestRunStatus ?? "";
		const outcome: TurnOutcome =
			status === "completed"
				? "finished"
				: status === "failed" || status === "timeout" || turnFailed
					? "stopped"
					: "live";
		closeTurn(outcome);
	}

	return plans.map(({ draft, outcome }) => ({
		id: draft.id,
		live: outcome === "live",
		sortSeq: (draft.anchorSeq ?? draft.ackSeq) + 0.5,
		steps: draft.titles.map((title, index) => {
			let status: PlanStepStatus;
			if (outcome === "finished" || index < draft.done) status = "done";
			else if (index === draft.done)
				status = outcome === "stopped" ? "stopped" : "in_progress";
			else status = "pending";
			return { note: draft.notes[index] ?? null, status, title };
		}),
	}));
};
