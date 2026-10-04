import { beforeEach, describe, expect, it } from "vitest";
import {
	chitKey,
	getProcessState as getState,
	type ProcessMeta,
	resetProcesses,
	setActiveTool,
	toolStatus,
	trackProcess,
} from "./store";

const P = "p1";
const map: ProcessMeta = { href: "/map", projectId: P, tool: "map" };
describe("process store", () => {
	beforeEach(() => resetProcesses());

	it("sums the counted processes of one tool", () => {
		trackProcess("a", map, { done: 6, total: 26 });
		trackProcess("b", map, { done: 4, total: 10 });
		trackProcess("c", map, { detail: "no count" });
		const s = getState();
		const status = toolStatus(s, P, "map");
		expect(status.running).toBe(3);
		expect(status.done).toBe(10);
		expect(status.total).toBe(36);
	});

	it("is indeterminate when nothing has a count", () => {
		trackProcess("a", map, {});
		expect(toolStatus(getState(), P, "map").total).toBeUndefined();
	});

	it("leaves a chit and a notice when it finishes elsewhere", () => {
		setActiveTool(P, "report");
		trackProcess("a", map, { done: 1, total: 2 });
		trackProcess("a", map, null);
		const s = getState();
		expect(s.chits[chitKey(P, "map")]).toEqual({
			failed: false,
			message: undefined,
		});
		expect(s.notices.map((n) => n.tool)).toEqual(["map"]);
		expect(toolStatus(s, P, "map").running).toBe(0);
	});

	it("finishes quietly on the tool you're on", () => {
		setActiveTool(P, "map");
		trackProcess("a", map, {});
		trackProcess("a", map, null, "boom");
		expect(getState().chits).toEqual({});
		expect(getState().notices).toEqual([]);
	});

	it("carries the failure and clears the chit when you open the tool", () => {
		trackProcess("a", map, {});
		trackProcess("a", map, null, "Not enough transcripts");
		expect(getState().chits[chitKey(P, "map")]).toEqual({
			failed: true,
			message: "Not enough transcripts",
		});
		setActiveTool(P, "map");
		expect(getState().chits).toEqual({});
	});

	it("ignores a finish it never saw start", () => {
		trackProcess("old", map, null, "old failure");
		expect(getState().notices).toEqual([]);
	});

	it("never notifies for a quiet process", () => {
		trackProcess("a", { ...map, quiet: true }, {});
		trackProcess("a", { ...map, quiet: true }, null);
		expect(getState().notices).toEqual([]);
	});
});
