// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FactCheckState, MapGraphNode } from "../types";
import type { FactCheckStates } from "./index";
import { useAutoFactCheck, useMapFactCheck } from "./useMapFactCheck";

const bffMock = vi.hoisted(() => ({
	delete: vi.fn(),
	get: vi.fn(),
	patch: vi.fn(),
	post: vi.fn(),
}));

vi.mock("@/lib/bff", () => ({ bff: bffMock }));

i18n.load("en-US", {});
i18n.activate("en-US");
vi.mock("@/components/common/Toaster", () => ({
	toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

const deferred = <T,>() => {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, reject, resolve };
};

const wrapper = ({ children }: { children: ReactNode }) => {
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

const done: FactCheckState = {
	checkedAt: "2026-09-15T10:00:00Z",
	justification: "Sources agree.",
	sources: [],
	status: "done",
	verdict: "true",
};

beforeEach(() => {
	vi.clearAllMocks();
	bffMock.get.mockResolvedValue({ fact_checks: { c1: { status: "idle" } } });
});

describe("useMapFactCheck", () => {
	it("shows processing while the start request is in flight", async () => {
		const post = deferred<FactCheckState>();
		bffMock.post.mockReturnValue(post.promise);
		const { result } = renderHook(
			() => useMapFactCheck({ readOnly: false, resultId: "r1" }),
			{ wrapper },
		);
		await waitFor(() => expect(result.current.states.c1).toBeDefined());

		act(() => {
			void result.current.run("c1");
		});
		expect(result.current.states.c1.status).toBe("processing");
		await waitFor(() =>
			expect(bffMock.post).toHaveBeenCalledWith(
				"/map/results/r1/fact-checks/c1",
				{},
			),
		);
		expect(result.current.states.c1.status).toBe("processing");

		await act(async () => {
			post.resolve(done);
		});
		expect(result.current.states.c1).toEqual(done);
	});

	it("sends force for a re-check", async () => {
		bffMock.post.mockResolvedValue({ startedAt: "x", status: "processing" });
		const { result } = renderHook(
			() => useMapFactCheck({ readOnly: false, resultId: "r1" }),
			{ wrapper },
		);
		await act(async () => {
			await result.current.run("c1", { force: true });
		});
		expect(bffMock.post).toHaveBeenCalledWith(
			"/map/results/r1/fact-checks/c1",
			{ force: true },
		);
	});

	it("cancels at once and ignores the start response that lands later", async () => {
		const post = deferred<FactCheckState>();
		const del = deferred<FactCheckState>();
		bffMock.post.mockReturnValue(post.promise);
		bffMock.delete.mockReturnValue(del.promise);
		const { result } = renderHook(
			() => useMapFactCheck({ readOnly: false, resultId: "r1" }),
			{ wrapper },
		);
		await waitFor(() => expect(result.current.states.c1).toBeDefined());

		act(() => {
			void result.current.run("c1");
		});
		act(() => {
			void result.current.cancel("c1");
		});
		expect(result.current.states.c1.status).toBe("idle");
		await waitFor(() =>
			expect(bffMock.delete).toHaveBeenCalledWith(
				"/map/results/r1/fact-checks/c1",
			),
		);
		expect(bffMock.post).toHaveBeenCalled();

		await act(async () => {
			post.resolve({ startedAt: "x", status: "processing" });
		});
		expect(result.current.states.c1.status).toBe("idle");

		await act(async () => {
			del.resolve({ status: "idle" });
		});
		expect(result.current.states.c1.status).toBe("idle");
	});

	it("turns a refused start into a retryable error", async () => {
		bffMock.post.mockRejectedValueOnce(
			Object.assign(new Error("unavailable"), { status: 503 }),
		);
		const { result } = renderHook(
			() => useMapFactCheck({ readOnly: false, resultId: "r1" }),
			{ wrapper },
		);
		await act(async () => {
			await result.current.run("c1");
		});
		expect(result.current.states.c1.status).toBe("error");

		bffMock.post.mockReturnValue(deferred<FactCheckState>().promise);
		act(() => {
			void result.current.run("c1");
		});
		expect(result.current.states.c1.status).toBe("processing");
	});

	it("never starts or cancels for a read-only role", async () => {
		const { result } = renderHook(
			() => useMapFactCheck({ readOnly: true, resultId: "r1" }),
			{ wrapper },
		);
		await act(async () => {
			await result.current.run("c1");
			await result.current.cancel("c1");
		});
		expect(bffMock.post).not.toHaveBeenCalled();
		expect(bffMock.delete).not.toHaveBeenCalled();
	});
});

const claim = (id: string): MapGraphNode => ({
	embedding: [1, 0],
	id,
	label: id,
	metadata: {
		conversationIds: [],
		createdAt: null,
		kind: "claim",
		quotes: [],
		valence: "neutral",
	},
});

describe("useAutoFactCheck", () => {
	const nodes: MapGraphNode[] = [
		claim("idle"),
		claim("error"),
		claim("done"),
		claim("processing"),
		claim("unknown-state"),
		{
			...claim("argument"),
			metadata: { ...claim("argument").metadata, kind: "argument" },
		},
	];
	const states: FactCheckStates = {
		done,
		error: { at: "x", message: "failed", status: "error" },
		idle: { status: "idle" },
		processing: { startedAt: "x", status: "processing" },
	};

	it("starts idle and error claims once per claim per result", () => {
		const run = vi.fn();
		const { rerender } = renderHook(
			(props: {
				enabled: boolean;
				resultId: string;
				states: FactCheckStates;
			}) => useAutoFactCheck({ ...props, nodes, run }),
			{ initialProps: { enabled: true, resultId: "r1", states } },
		);
		expect(run.mock.calls.map(([id]) => id).sort()).toEqual([
			"error",
			"idle",
			"unknown-state",
		]);

		// The claims come back idle (a cancel, a failure): not fired again.
		rerender({
			enabled: true,
			resultId: "r1",
			states: { ...states, processing: { status: "idle" } },
		});
		rerender({ enabled: false, resultId: "r1", states });
		rerender({ enabled: true, resultId: "r1", states: { ...states } });
		expect(run.mock.calls.map(([id]) => id).sort()).toEqual([
			"error",
			"idle",
			"processing",
			"unknown-state",
		]);

		// A new result starts a new session of checks.
		rerender({ enabled: true, resultId: "r2", states });
		expect(run).toHaveBeenCalledTimes(7);
	});

	it("does nothing while disabled", () => {
		const run = vi.fn();
		renderHook(() =>
			useAutoFactCheck({ enabled: false, nodes, resultId: "r1", run, states }),
		);
		expect(run).not.toHaveBeenCalled();
	});
});
