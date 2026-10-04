import { useMemo, useSyncExternalStore } from "react";

/** The rail items that can show work in progress. */
export type Tool = "ask" | "conversations" | "map" | "present" | "report";

export const TOOLS: readonly Tool[] = [
	"ask",
	"conversations",
	"map",
	"present",
	"report",
];

/** Where a running process is. No total means it can't be counted. */
export type Progress = { done?: number; total?: number; detail?: string };

export type ProcessMeta = {
	projectId: string;
	tool: Tool;
	/** Where the toast's "Open …" goes. */
	href: string;
	/** Finishes without a chit or toast (a live loop's routine reads). */
	quiet?: boolean;
};

type Process = ProcessMeta & Progress;

/** What a finished process leaves on its tool until you open the tool. */
export type Chit = { failed: boolean; message?: string };

export type Notice = ProcessMeta & Chit & { id: number };

type State = {
	processes: Record<string, Process>;
	chits: Record<string, Chit>;
	/** The tool on screen; what finishes there needs no chit or toast. */
	active: { projectId: string; tool: Tool | null } | null;
	/** The latest finishes, oldest first; two can land in one reading. */
	notices: Notice[];
	/** The chit whose rail item pops its name out (phones). */
	popout: string | null;
};

let state: State = {
	active: null,
	chits: {},
	notices: [],
	popout: null,
	processes: {},
};
let noticeId = 0;
const listeners = new Set<() => void>();

const set = (next: Partial<State>) => {
	state = { ...state, ...next };
	for (const listener of listeners) listener();
};

export const chitKey = (projectId: string, tool: Tool) =>
	`${projectId}:${tool}`;

const sameProgress = (a: Process | undefined, b: Process) =>
	!!a &&
	a.done === b.done &&
	a.total === b.total &&
	a.detail === b.detail &&
	a.quiet === b.quiet &&
	a.href === b.href;

const settle = (key: string, failed: boolean, message?: string) => {
	const process = state.processes[key];
	const { [key]: _, ...processes } = state.processes;
	const here =
		state.active?.projectId === process.projectId &&
		state.active.tool === process.tool;
	if (process.quiet || here) {
		set({ processes });
		return;
	}
	const { projectId, tool, href } = process;
	set({
		chits: { ...state.chits, [chitKey(projectId, tool)]: { failed, message } },
		notices: [
			...state.notices.slice(-4),
			{ failed, href, id: ++noticeId, message, projectId, tool },
		],
		processes,
	});
};

/**
 * Tells the store what a process is doing now. Call it with every reading:
 * progress while it runs, null once it has finished, or null with a failure
 * message once it has failed. Only a process the store saw running can
 * finish, so a reading taken after the fact (an old failure) stays silent.
 */
export const trackProcess = (
	key: string,
	meta: ProcessMeta,
	progress: Progress | null,
	failure?: string,
) => {
	if (progress) {
		const next = { ...meta, ...progress };
		if (sameProgress(state.processes[key], next)) return;
		set({ processes: { ...state.processes, [key]: next } });
		return;
	}
	if (!state.processes[key]) return;
	settle(key, failure !== undefined, failure || undefined);
};

/** The tool now on screen. Opening a tool clears its chit. */
export const setActiveTool = (projectId: string | null, tool: Tool | null) => {
	const active = projectId ? { projectId, tool } : null;
	if (
		state.active?.projectId === active?.projectId &&
		state.active?.tool === active?.tool
	)
		return;
	const chits = { ...state.chits };
	if (projectId && tool) delete chits[chitKey(projectId, tool)];
	set({ active, chits });
};

export const setPopout = (key: string | null) => set({ popout: key });

/** Keys of the running processes of one tool, any project (Ask polls them). */
export const runningKeys = (tool: Tool) =>
	Object.entries(state.processes)
		.filter(([, process]) => process.tool === tool)
		.map(([key, process]) => ({ key, process }));

const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};
const snapshot = () => state;
export const getProcessState = snapshot;

export const useProcessState = () => useSyncExternalStore(subscribe, snapshot);

export type ToolStatus = {
	running: number;
	/** Sum over the counted processes; absent when none has a count. */
	done?: number;
	total?: number;
	details: string[];
	chit?: Chit;
	popout: boolean;
};

/** One tool's status: the counted work summed, its chit. */
export const toolStatus = (s: State, projectId: string, tool: Tool) => {
	const mine = Object.values(s.processes).filter(
		(p) => p.projectId === projectId && p.tool === tool,
	);
	const counted = mine.filter((p) => p.total);
	const key = chitKey(projectId, tool);
	const status: ToolStatus = {
		chit: s.chits[key],
		details: [...new Set(mine.flatMap((p) => (p.detail ? [p.detail] : [])))],
		popout: s.popout === key,
		running: mine.length,
	};
	if (counted.length) {
		status.done = counted.reduce((sum, p) => sum + (p.done ?? 0), 0);
		status.total = counted.reduce((sum, p) => sum + (p.total ?? 0), 0);
	}
	return status;
};

export const useToolStatuses = (projectId: string | undefined) => {
	const s = useProcessState();
	return useMemo(() => {
		const out = {} as Record<Tool, ToolStatus | undefined>;
		for (const tool of TOOLS)
			out[tool] = projectId ? toolStatus(s, projectId, tool) : undefined;
		return out;
	}, [s, projectId]);
};

/** Test-only: back to an empty store. */
export const resetProcesses = () =>
	set({ active: null, chits: {}, notices: [], popout: null, processes: {} });
