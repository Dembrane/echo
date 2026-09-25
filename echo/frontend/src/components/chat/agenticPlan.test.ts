import { describe, expect, it } from "vitest";
import type { AgenticRunEvent } from "@/lib/api";
import { derivePlans } from "./agenticPlan";

let seq = 0;
const event = (
	event_type: string,
	payload: Record<string, unknown> | null = null,
): AgenticRunEvent => {
	seq += 1;
	return {
		event_type,
		id: seq,
		payload,
		project_agentic_run_id: "run-1",
		seq,
		timestamp: "2026-09-25T10:00:00Z",
	};
};

const toolStart = (name: string, input: Record<string, unknown>) =>
	event("on_tool_start", { data: { input }, name });

const PLAN = ["Read the conversations", "Group the themes", "Write it up"];

describe("derivePlans", () => {
	it("seeds the steps from the first ack with the first one running", () => {
		seq = 0;
		const events = [
			event("user.message", { content: "themes?" }),
			toolStart("ack", { message: "You want the themes.", plan: PLAN }),
			event("assistant.message", { content: "You want the themes." }),
		];

		const [plan] = derivePlans(events, "running");

		expect(plan.live).toBe(true);
		expect(plan.steps.map((step) => step.status)).toEqual([
			"in_progress",
			"pending",
			"pending",
		]);
		// Sits right after the ack message.
		expect(plan.sortSeq).toBe(3.5);
	});

	it("ticks steps off with updatePlan and keeps each step's note", () => {
		seq = 0;
		const events = [
			event("user.message"),
			toolStart("ack", { message: "On it.", plan: PLAN }),
			toolStart("updatePlan", {
				done: 1,
				note: "12 conversations",
				steps: PLAN,
			}),
			toolStart("updatePlan", { done: 2, note: "4 themes", steps: PLAN }),
		];

		const [plan] = derivePlans(events, "running");

		expect(plan.steps).toEqual([
			{ note: "12 conversations", status: "done", title: PLAN[0] },
			{ note: "4 themes", status: "done", title: PLAN[1] },
			{ note: null, status: "in_progress", title: PLAN[2] },
		]);
	});

	it("sweeps the plan complete when the turn finishes", () => {
		seq = 0;
		const events = [
			event("user.message"),
			toolStart("ack", { message: "On it.", plan: PLAN }),
			toolStart("updatePlan", { done: 1, steps: PLAN }),
			event("assistant.message", { content: "Here are the themes." }),
		];

		const [plan] = derivePlans(events, "completed");

		expect(plan.live).toBe(false);
		expect(plan.steps.every((step) => step.status === "done")).toBe(true);
	});

	it("marks the running step stopped when the turn fails", () => {
		seq = 0;
		const events = [
			event("user.message"),
			toolStart("ack", { message: "On it.", plan: PLAN }),
			toolStart("updatePlan", { done: 1, steps: PLAN }),
			event("run.failed", { error_code: "AGENT_TIMEOUT" }),
		];

		const [plan] = derivePlans(events, "failed");

		expect(plan.steps.map((step) => step.status)).toEqual([
			"done",
			"stopped",
			"pending",
		]);
	});

	it("keeps finished steps done when the plan is revised", () => {
		seq = 0;
		const revised = [PLAN[0], "Compare with last year", "Write it up"];
		const events = [
			event("user.message"),
			toolStart("ack", { message: "On it.", plan: PLAN }),
			toolStart("updatePlan", { done: 1, note: "12 read", steps: PLAN }),
			toolStart("updatePlan", { done: 1, steps: revised }),
		];

		const [plan] = derivePlans(events, "running");

		expect(plan.steps.map((step) => step.title)).toEqual(revised);
		expect(plan.steps[0]).toEqual({
			note: "12 read",
			status: "done",
			title: PLAN[0],
		});
		expect(plan.steps[1].status).toBe("in_progress");
	});

	it("gives each turn its own plan and finishes the earlier one", () => {
		seq = 0;
		const events = [
			event("user.message"),
			toolStart("ack", { message: "On it.", plan: PLAN }),
			event("assistant.message", { content: "Done." }),
			event("user.message"),
			toolStart("ack", { message: "Again.", plan: ["One", "Two"] }),
		];

		const plans = derivePlans(events, "running");

		expect(plans).toHaveLength(2);
		expect(plans[0].live).toBe(false);
		expect(plans[0].steps.every((step) => step.status === "done")).toBe(true);
		expect(plans[1].live).toBe(true);
	});

	it("ignores an ack without a plan and an updatePlan before any plan", () => {
		seq = 0;
		const events = [
			event("user.message"),
			toolStart("updatePlan", { done: 1, steps: PLAN }),
			toolStart("ack", { message: "Quick one." }),
		];

		expect(derivePlans(events, "running")).toEqual([]);
	});
});
