// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type Mock,
	vi,
} from "vitest";
import type { FactCheckState, MapGraphNode } from "../types";
import { type FactCheckStates, mapKeys } from "./index";
import {
	FACT_CHECK_CONCURRENCY,
	RATE_LIMIT_BACKOFF_MS,
	useAutoFactCheck,
	useMapFactCheck,
} from "./useMapFactCheck";

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

const makeClient = () =>
	new QueryClient({
		defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
	});

const wrapperFor =
	(client: QueryClient) =>
	({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);

const wrapper = ({ children }: { children: ReactNode }) =>
	wrapperFor(makeClient())({ children });

const done: FactCheckState = {
	checkedAt: "2026-09-15T10:00:00Z",
	justification: "Sources agree.",
	sources: [],
	status: "done",
	verdict: "true",
};

const httpError = (status: number) =>
	Object.assign(new Error(`HTTP ${status}`), { status });

const claim = (id: string): MapGraphNode => ({
	embedding: [1, 0],
	id,
	label: id,
	metadata: {
		conversationIds: [],
		createdAt: null,
		epistemicKind: "claim",
		kind: "claim",
		objectId: id,
		objectType: "argument",
		quotes: [],
		revisionId: id,
		sizeScale: 1,
		valence: "neutral",
	},
});

beforeEach(() => {
	vi.clearAllMocks();
	bffMock.get.mockResolvedValue({ fact_checks: { c1: { status: "idle" } } });
});

afterEach(() => {
	vi.useRealTimers();
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
			result.current.run("c1");
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
		act(() => {
			result.current.run("c1", { force: true });
		});
		await waitFor(() =>
			expect(bffMock.post).toHaveBeenCalledWith(
				"/map/results/r1/fact-checks/c1",
				{ force: true },
			),
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
			result.current.run("c1");
		});
		await waitFor(() => expect(bffMock.post).toHaveBeenCalled());
		act(() => {
			void result.current.cancel("c1");
		});
		expect(result.current.states.c1.status).toBe("idle");
		await waitFor(() =>
			expect(bffMock.delete).toHaveBeenCalledWith(
				"/map/results/r1/fact-checks/c1",
			),
		);

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
		bffMock.post.mockRejectedValueOnce(httpError(503));
		const { result } = renderHook(
			() => useMapFactCheck({ readOnly: false, resultId: "r1" }),
			{ wrapper },
		);
		act(() => {
			result.current.run("c1");
		});
		await waitFor(() => expect(result.current.states.c1.status).toBe("error"));
		// The saved (idle) state landing afterwards is no change from the server.
		await waitFor(() => expect(result.current.ready).toBe(true));
		expect(result.current.states.c1.status).toBe("error");

		bffMock.post.mockReturnValue(deferred<FactCheckState>().promise);
		act(() => {
			result.current.run("c1");
		});
		expect(result.current.states.c1.status).toBe("processing");
	});

	it("never starts or cancels for a read-only role", async () => {
		const { result } = renderHook(
			() => useMapFactCheck({ readOnly: true, resultId: "r1" }),
			{ wrapper },
		);
		await act(async () => {
			result.current.run("c1");
			result.current.runAll(["c1"]);
			await result.current.cancel("c1");
		});
		expect(bffMock.post).not.toHaveBeenCalled();
		expect(bffMock.delete).not.toHaveBeenCalled();
	});

	it("is ready only once the saved states have loaded", async () => {
		const get = deferred<{ fact_checks: FactCheckStates }>();
		bffMock.get.mockReturnValue(get.promise);
		const { result } = renderHook(
			() => useMapFactCheck({ readOnly: false, resultId: "r1" }),
			{ wrapper },
		);
		expect(result.current.ready).toBe(false);
		await act(async () => {
			get.resolve({ fact_checks: {} });
		});
		await waitFor(() => expect(result.current.ready).toBe(true));

		const offline = renderHook(
			() => useMapFactCheck({ offline: true, readOnly: false, resultId: "r1" }),
			{ wrapper },
		);
		expect(offline.result.current.ready).toBe(true);
	});

	it("keeps a verdict that arrived while the start request was in flight", async () => {
		const client = makeClient();
		const post = deferred<FactCheckState>();
		bffMock.post.mockReturnValue(post.promise);
		const { result } = renderHook(
			() => useMapFactCheck({ readOnly: false, resultId: "r1" }),
			{ wrapper: wrapperFor(client) },
		);
		await waitFor(() => expect(result.current.states.c1).toBeDefined());

		act(() => {
			result.current.run("c1");
		});
		await waitFor(() => expect(bffMock.post).toHaveBeenCalled());

		// The worker finishes and the event refetch lands first.
		const finished: FactCheckState = {
			...done,
			checkedAt: "2026-09-15T10:00:05Z",
		};
		bffMock.get.mockResolvedValue({ fact_checks: { c1: finished } });
		await act(async () => {
			await client.invalidateQueries({ queryKey: mapKeys.factChecks("r1") });
		});

		// Then the start response, older than the verdict, settles.
		await act(async () => {
			post.resolve({ startedAt: "2026-09-15T10:00:00Z", status: "processing" });
		});
		expect(result.current.states.c1).toEqual(finished);
		expect(
			client.getQueryData<FactCheckStates>(mapKeys.factChecks("r1"))?.c1,
		).toEqual(finished);
	});

	it("drops a start error once the server reports a different state", async () => {
		const client = makeClient();
		// Refetches, then lets the query hand its new data to the hook.
		const refetch = () =>
			act(async () => {
				await client.invalidateQueries({ queryKey: mapKeys.factChecks("r1") });
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
		const post = deferred<FactCheckState>();
		bffMock.post.mockReturnValue(post.promise);
		const { result } = renderHook(
			() => useMapFactCheck({ readOnly: false, resultId: "r1" }),
			{ wrapper: wrapperFor(client) },
		);
		await waitFor(() => expect(result.current.states.c1).toBeDefined());

		act(() => {
			result.current.run("c1");
		});
		await waitFor(() => expect(bffMock.post).toHaveBeenCalled());
		// The server accepted the start, but its response was lost.
		await act(async () => {
			post.reject(httpError(502));
		});
		expect(result.current.states.c1.status).toBe("error");

		// A refetch with the same state leaves the error standing.
		await refetch();
		expect(result.current.states.c1.status).toBe("error");

		bffMock.get.mockResolvedValue({ fact_checks: { c1: done } });
		await refetch();
		expect(result.current.states.c1).toEqual(done);

		// And it stays gone if the server later returns to idle.
		bffMock.get.mockResolvedValue({ fact_checks: { c1: { status: "idle" } } });
		await refetch();
		expect(result.current.states.c1.status).toBe("idle");
	});

	it("keeps at most four starts in flight", async () => {
		const ids = Array.from({ length: 10 }, (_, index) => `c${index}`);
		bffMock.get.mockResolvedValue({
			fact_checks: Object.fromEntries(
				ids.map((id) => [id, { status: "idle" }]),
			),
		});
		const posts: ReturnType<typeof deferred<FactCheckState>>[] = [];
		bffMock.post.mockImplementation(() => {
			const post = deferred<FactCheckState>();
			posts.push(post);
			return post.promise;
		});
		const { result } = renderHook(
			() => useMapFactCheck({ readOnly: false, resultId: "r1" }),
			{ wrapper },
		);
		await waitFor(() => expect(result.current.ready).toBe(true));

		act(() => {
			result.current.runAll(ids);
		});
		for (const id of ids) {
			expect(result.current.states[id].status).toBe("processing");
		}
		await waitFor(() => expect(posts).toHaveLength(FACT_CHECK_CONCURRENCY));
		await act(async () => {});
		expect(posts).toHaveLength(FACT_CHECK_CONCURRENCY);

		await act(async () => {
			posts[0].resolve({ startedAt: "x", status: "processing" });
		});
		await waitFor(() => expect(posts).toHaveLength(FACT_CHECK_CONCURRENCY + 1));
		await act(async () => {});
		expect(posts).toHaveLength(FACT_CHECK_CONCURRENCY + 1);
	});

	it("pauses on 429 and retries the claim instead of failing it", async () => {
		const { result } = renderHook(
			() => useMapFactCheck({ readOnly: false, resultId: "r1" }),
			{ wrapper },
		);
		await waitFor(() => expect(result.current.ready).toBe(true));

		vi.useFakeTimers();
		bffMock.post
			.mockRejectedValueOnce(httpError(429))
			.mockResolvedValueOnce({ startedAt: "x", status: "processing" });
		act(() => {
			result.current.run("c1");
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(bffMock.post).toHaveBeenCalledTimes(1);
		expect(result.current.states.c1.status).toBe("processing");

		await act(async () => {
			await vi.advanceTimersByTimeAsync(RATE_LIMIT_BACKOFF_MS - 1);
		});
		expect(bffMock.post).toHaveBeenCalledTimes(1);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(1);
		});
		expect(bffMock.post).toHaveBeenCalledTimes(2);
		expect(result.current.states.c1).toEqual({
			startedAt: "x",
			status: "processing",
		});
	});

	it("waits for saved states before auto-checking a cold load", async () => {
		const get = deferred<{ fact_checks: FactCheckStates }>();
		bffMock.get.mockReturnValue(get.promise);
		bffMock.post.mockResolvedValue({ startedAt: "x", status: "processing" });
		const nodes = [claim("c1"), claim("c2"), claim("c3")];
		const { result } = renderHook(
			() => {
				const factCheck = useMapFactCheck({ readOnly: false, resultId: "r1" });
				useAutoFactCheck({
					enabled: true,
					nodes,
					ready: factCheck.ready,
					resultId: "r1",
					runAll: factCheck.runAll,
					states: factCheck.states,
				});
				return factCheck;
			},
			{ wrapper },
		);
		await act(async () => {});
		expect(bffMock.post).not.toHaveBeenCalled();

		await act(async () => {
			get.resolve({
				fact_checks: {
					c1: done,
					c2: { status: "idle" },
					c3: { startedAt: "x", status: "processing" },
				},
			});
		});
		await waitFor(() => expect(result.current.ready).toBe(true));
		await waitFor(() => expect(bffMock.post).toHaveBeenCalledTimes(1));
		expect(bffMock.post).toHaveBeenCalledWith(
			"/map/results/r1/fact-checks/c2",
			{},
		);
		await act(async () => {});
		expect(bffMock.post).toHaveBeenCalledTimes(1);
		expect(result.current.states.c1).toEqual(done);
	});
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
			metadata: {
				...claim("argument").metadata,
				epistemicKind: "argument",
				kind: "argument",
			},
		},
	];
	const states: FactCheckStates = {
		done,
		error: { at: "x", message: "failed", status: "error" },
		idle: { status: "idle" },
		processing: { startedAt: "x", status: "processing" },
	};
	const firedIds = (runAll: Mock) =>
		runAll.mock.calls.flatMap(([ids]) => ids as string[]).sort();

	it("starts idle and error claims once per claim per result", () => {
		const runAll = vi.fn();
		const { rerender } = renderHook(
			(props: {
				enabled: boolean;
				resultId: string;
				states: FactCheckStates;
			}) => useAutoFactCheck({ ...props, nodes, ready: true, runAll }),
			{ initialProps: { enabled: true, resultId: "r1", states } },
		);
		expect(runAll).toHaveBeenCalledTimes(1);
		expect(firedIds(runAll)).toEqual(["error", "idle", "unknown-state"]);

		// The claims come back idle (a cancel, a failure): not fired again.
		rerender({
			enabled: true,
			resultId: "r1",
			states: { ...states, processing: { status: "idle" } },
		});
		rerender({ enabled: false, resultId: "r1", states });
		rerender({ enabled: true, resultId: "r1", states: { ...states } });
		expect(firedIds(runAll)).toEqual([
			"error",
			"idle",
			"processing",
			"unknown-state",
		]);

		// A new result starts a new session of checks.
		rerender({ enabled: true, resultId: "r2", states });
		expect(firedIds(runAll)).toHaveLength(7);
	});

	it("does nothing while disabled", () => {
		const runAll = vi.fn();
		renderHook(() =>
			useAutoFactCheck({
				enabled: false,
				nodes,
				ready: true,
				resultId: "r1",
				runAll,
				states,
			}),
		);
		expect(runAll).not.toHaveBeenCalled();
	});

	it("marks nothing fired before the saved states are known", () => {
		const runAll = vi.fn();
		const { rerender } = renderHook(
			(props: { ready: boolean; states: FactCheckStates }) =>
				useAutoFactCheck({
					...props,
					enabled: true,
					nodes,
					resultId: "r1",
					runAll,
				}),
			{ initialProps: { ready: false, states: {} } },
		);
		expect(runAll).not.toHaveBeenCalled();

		rerender({ ready: true, states });
		expect(firedIds(runAll)).toEqual(["error", "idle", "unknown-state"]);
	});
});
