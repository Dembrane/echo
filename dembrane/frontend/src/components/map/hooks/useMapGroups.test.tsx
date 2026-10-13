// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSyntheticMap } from "../fixtures/syntheticMap";
import { buildMST, centralityOrder } from "../graph/mst";
import {
	createMapInteractionStore,
	MapInteractionProvider,
	type MapInteractionStore,
} from "../state/interactionStore";
import type { MapGroupDoc, MapGroupRequest } from "./index";
import {
	COMMIT_FLASH_MS,
	DWELL_MS,
	type GroupBackend,
	POLL_MS,
	useMapGroups,
} from "./useMapGroups";

const nodes = createSyntheticMap({ count: 16 });
const edges = buildMST(nodes);
const ids = (...indexes: number[]) => indexes.map((index) => nodes[index].id);

/** A server in memory whose runs finish only when the test says so. */
const fakeServer = () => {
	const docs: MapGroupDoc[] = [];
	let refuse: number | null = null;
	const backend: GroupBackend = {
		create: vi.fn(async (_resultId: string, request: MapGroupRequest) => {
			if (refuse !== null) {
				const status = refuse;
				refuse = null;
				throw Object.assign(new Error("no"), { status });
			}
			const key = [...request.revisionIds].sort().join(",");
			const existing = docs.find(
				(doc) =>
					doc.members
						.map((m) => m.revisionId)
						.sort()
						.join(",") === key,
			);
			if (existing) {
				if (existing.status === "failed") existing.status = "pending";
				return { ...existing };
			}
			const doc: MapGroupDoc = {
				createdAt: new Date(Date.now() + docs.length).toISOString(),
				error: null,
				id: `group-${docs.length + 1}`,
				members: request.revisionIds.map((revisionId) => ({
					objectId: revisionId,
					revisionId,
					type: "argument",
				})),
				snapshotId: request.snapshotId,
				status: "pending",
				title: null,
			};
			docs.unshift(doc);
			return { ...doc };
		}),
		list: vi.fn(async () => docs.map((doc) => ({ ...doc }))),
	};
	const land = (id: string, patch: Partial<MapGroupDoc>) =>
		Object.assign(docs.find((doc) => doc.id === id) ?? {}, patch);
	return {
		backend,
		docs,
		land,
		refuseNext: (status: number) => {
			refuse = status;
		},
	};
};

const setup = (backend: GroupBackend, canCommit = true) => {
	const store = createMapInteractionStore();
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			<MapInteractionProvider store={store}>{children}</MapInteractionProvider>
		</QueryClientProvider>
	);
	const hook = renderHook(
		() =>
			useMapGroups({
				backend,
				canCommit,
				edges,
				nodes,
				resultId: "result-1",
				snapshotId: "snapshot-1",
			}),
		{ wrapper },
	);
	return { hook, store };
};

const highlight = (
	store: MapInteractionStore,
	nodeIds: string[],
	isPreview = false,
) =>
	act(() => {
		store.setHighlightedNodeIds(new Set(nodeIds), {
			isPreview,
			source: "local-hover",
		});
	});

const wait = (ms: number) =>
	act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("useMapGroups", () => {
	it("commits once the circle closes, and a move before that sends nothing", async () => {
		const server = fakeServer();
		const { hook, store } = setup(server.backend);
		const selection = ids(0, 4, 8, 12);

		highlight(store, selection);
		expect(hook.result.current.timerActive).toBe(true);
		await wait(DWELL_MS - 1);
		highlight(store, ids(1, 2), true);
		await wait(DWELL_MS);
		expect(server.backend.create).not.toHaveBeenCalled();

		highlight(store, selection);
		await wait(DWELL_MS);
		expect(server.backend.create).toHaveBeenCalledWith("result-1", {
			revisionIds: centralityOrder(selection, nodes, edges),
			snapshotId: "snapshot-1",
		});
		// The closed circle shows whole for a moment, then clears.
		expect(hook.result.current.timerProgress).toBe(1);
		await wait(COMMIT_FLASH_MS);
		expect(hook.result.current.timerActive).toBe(false);
		expect(hook.result.current.history[0]?.status).toBe("pending");

		// Moving away no longer matters: the title lands and Spotlight shows it.
		highlight(store, []);
		server.land("group-1", { status: "ready", title: "Ferry timetables" });
		await wait(POLL_MS);
		expect(hook.result.current.history).toHaveLength(1);
		expect(hook.result.current.history[0]).toMatchObject({
			id: "group-1",
			status: "done",
			title: "Ferry timetables",
		});
		expect(hook.result.current.selectedDistillationId).toBe("group-1");
		expect(store.getState().highlightedNodeIds).toEqual(new Set(selection));
	});

	it("lists the project's groups from the server, also after a regeneration", async () => {
		const server = fakeServer();
		server.docs.push({
			createdAt: "2026-10-01T10:00:00Z",
			error: null,
			id: "theirs",
			// Made on an older snapshot: found by object where the revision moved on.
			members: ids(1, 2, 3).map((id) => ({
				objectId: id,
				revisionId: `old-${id}`,
				type: "argument",
			})),
			snapshotId: "snapshot-0",
			status: "ready",
			title: "Someone else's cluster",
		});
		const { hook, store } = setup(server.backend);
		await wait(0);
		expect(hook.result.current.history).toEqual([
			expect.objectContaining({
				id: "theirs",
				nodeIds: ids(1, 2, 3),
				status: "done",
				title: "Someone else's cluster",
			}),
		]);

		// A set that already is a group starts no circle.
		highlight(store, ids(3, 1, 2));
		expect(hook.result.current.timerActive).toBe(false);
	});

	it("keeps a refused commit on the page, and a failed run can be tried again", async () => {
		const server = fakeServer();
		const { hook, store } = setup(server.backend);

		server.refuseNext(413);
		highlight(store, ids(0, 1, 2));
		await wait(DWELL_MS);
		expect(hook.result.current.history[0]?.status).toBe("too-large");

		highlight(store, ids(5, 6, 7));
		await wait(DWELL_MS);
		server.land("group-1", { status: "failed" });
		await wait(POLL_MS);
		const failed = hook.result.current.history.find(
			(entry) => entry.status === "failed",
		);
		expect(failed?.id).toBe("group-1");

		act(() => hook.result.current.retry("group-1"));
		await wait(0);
		expect(server.backend.create).toHaveBeenCalledTimes(3);
		expect(
			hook.result.current.history.find((entry) => entry.id === "group-1")
				?.status,
		).toBe("pending");
	});

	it("shows groups without making any where the viewer may not change the project", async () => {
		const server = fakeServer();
		const { hook, store } = setup(server.backend, false);
		highlight(store, ids(0, 4, 8));
		expect(hook.result.current.timerActive).toBe(false);
		await wait(DWELL_MS);
		expect(server.backend.create).not.toHaveBeenCalled();
		expect(server.backend.list).toHaveBeenCalled();
	});

	it("lists groups it is handed without asking the server, and makes none", async () => {
		const server = fakeServer();
		const store = createMapInteractionStore();
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>
				<MapInteractionProvider store={store}>
					{children}
				</MapInteractionProvider>
			</QueryClientProvider>
		);
		const docs: MapGroupDoc[] = [
			{
				createdAt: "2026-10-06T10:00:00+00:00",
				error: null,
				id: "room-group",
				members: ids(0, 4, 8).map((revisionId) => ({
					objectId: revisionId,
					revisionId,
					type: "argument",
				})),
				snapshotId: "snapshot-1",
				status: "failed",
				title: null,
			},
		];
		const hook = renderHook(
			() =>
				useMapGroups({
					backend: server.backend,
					canCommit: false,
					docs,
					edges,
					nodes,
					resultId: "result-1",
					snapshotId: "snapshot-1",
				}),
			{ wrapper },
		);
		expect(hook.result.current.history.map((entry) => entry.id)).toEqual([
			"room-group",
		]);
		highlight(store, ids(1, 5, 9));
		expect(hook.result.current.timerActive).toBe(false);
		await wait(DWELL_MS + POLL_MS);
		act(() => hook.result.current.retry("room-group"));
		await wait(0);
		expect(server.backend.list).not.toHaveBeenCalled();
		expect(server.backend.create).not.toHaveBeenCalled();
	});
});
