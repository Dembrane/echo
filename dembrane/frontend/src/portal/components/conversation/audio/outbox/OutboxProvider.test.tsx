// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
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
import { createDrainer, type OutboxApi } from "./drainOutbox";
import { type Outbox, OutboxProvider, useOutbox } from "./OutboxProvider";
import { type OutboxStore, openOutboxStore } from "./outboxStore";

const capture = vi.fn();
vi.mock("posthog-js", () => ({
	default: { capture: (...a: unknown[]) => capture(...a) },
}));

const fallbackUpload = vi.fn();
vi.mock("../hooks/useUploadConversationChunk", () => ({
	useUploadConversationChunk: () => ({
		mutateAsync: (...a: unknown[]) => fallbackUpload(...a),
	}),
}));

/**
 * jsdom has no Web Locks: exclusive locks by name, granted in request order,
 * which is all the drain lock and the recording locks need.
 */
const fakeLockManager = () => {
	const held = new Set<string>();
	const queues = new Map<string, Promise<unknown>>();
	return {
		query: async () => ({
			held: [...held].map((name) => ({ name })),
			pending: [],
		}),
		request: (name: string, ...args: unknown[]) => {
			const callback = args.at(-1) as () => Promise<unknown>;
			const options = (args.length > 1 ? args[0] : {}) as {
				signal?: AbortSignal;
			};
			const granted = (queues.get(name) ?? Promise.resolve()).then(async () => {
				if (options.signal?.aborted)
					throw new DOMException("Aborted", "AbortError");
				held.add(name);
				try {
					return await callback();
				} finally {
					held.delete(name);
				}
			});
			queues.set(
				name,
				granted.catch(() => {}),
			);
			return granted;
		},
	};
};

let dbName: string;
let api: { [K in keyof OutboxApi]: Mock<OutboxApi[K]> };
let outbox: Outbox;

const Capture = () => {
	outbox = useOutbox();
	return <span data-testid="count">{outbox.queuedCount("conv-1")}</span>;
};

const tree = (
	openStore: () => Promise<OutboxStore> = () => openOutboxStore({ dbName }),
): ReactNode => (
	<QueryClientProvider client={new QueryClient()}>
		<OutboxProvider api={api} openStore={openStore}>
			<Capture />
		</OutboxProvider>
	</QueryClientProvider>
);

/** When each test's recording starts. */
const STARTED_AT = "2026-10-14T10:00:00.000Z";

const slice = (...bytes: number[]) =>
	new Blob([new Uint8Array(bytes)], { type: "audio/webm" });

/** Opens one chunk, the way the recorder does as a MediaRecorder starts. */
const begin = () =>
	outbox
		.openChunkSink({ conversationId: "conv-1", source: "PORTAL_AUDIO" })
		.begin("audio/webm");

/** Records one chunk the way the recorder does: its slices, then the seal. */
const recordChunk = (...slices: Blob[]) => {
	const writer = begin();
	for (const s of slices.length ? slices : [slice(1, 2, 3)]) writer.append(s);
	return writer.seal();
};

const bytesOf = (audio: ArrayBuffer) => Array.from(new Uint8Array(audio));

/** A second connection to the provider's database, as another tab would have. */
const openSameStore = () => openOutboxStore({ dbName });

const waitForSlices = (store: OutboxStore, sliceCount: number) =>
	waitFor(async () =>
		expect(await store.listSliceGroups()).toEqual([
			expect.objectContaining({ conversationId: "conv-1", sliceCount }),
		]),
	);

const neverSettles = () => new Promise<never>(() => {});

beforeEach(() => {
	dbName = `provider-test-${crypto.randomUUID()}`;
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(STARTED_AT));
	Object.defineProperty(navigator, "locks", {
		configurable: true,
		value: fakeLockManager(),
	});
	api = {
		confirm: vi.fn<OutboxApi["confirm"]>().mockResolvedValue(undefined),
		upload: vi
			.fn<OutboxApi["upload"]>()
			.mockResolvedValue({ chunk_id: "c1", file_url: "https://s3/c1" }),
	};
	fallbackUpload.mockResolvedValue({});
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.clearAllMocks();
});

it("sends a recorded chunk and settles once it's confirmed", async () => {
	const { getByTestId } = render(tree());

	await act(() => recordChunk());
	await act(() => outbox.settled("conv-1"));

	expect(api.upload).toHaveBeenCalledWith(
		expect.objectContaining({
			conversationId: "conv-1",
			mimeType: "audio/webm",
			source: "PORTAL_AUDIO",
			timestamp: STARTED_AT,
		}),
	);
	expect(api.confirm).toHaveBeenCalledTimes(1);
	expect(getByTestId("count").textContent).toBe("0");
	expect(capture).toHaveBeenCalledWith(
		"portal_outbox_delivered",
		expect.objectContaining({
			attempts: 1,
			conversation_id: "conv-1",
			kind: "chunk",
		}),
	);
});

it("counts a chunk as queued while it can't be sent", async () => {
	api.upload.mockImplementation(neverSettles);
	const { getByTestId } = render(tree());

	await act(() => recordChunk());

	await waitFor(() => expect(getByTestId("count").textContent).toBe("1"));
});

it("keeps a chunk it couldn't send across a reload, and sends it then", async () => {
	api.upload.mockRejectedValue(new Error("Network Error"));
	const first = render(tree());
	await act(() => recordChunk());
	await waitFor(() => expect(api.upload).toHaveBeenCalled());
	first.unmount();

	api.upload.mockResolvedValue({ chunk_id: "c1", file_url: "https://s3/c1" });
	render(tree());

	await waitFor(() => expect(api.confirm).toHaveBeenCalledTimes(1));
	await act(() => outbox.settled("conv-1"));
});

it("tries again as soon as the browser is back online", async () => {
	api.upload.mockRejectedValueOnce(new Error("Network Error"));
	render(tree());
	await act(() => recordChunk());
	await waitFor(() => expect(api.upload).toHaveBeenCalledTimes(1));

	// The clock is stopped, so only the online event can explain a retry.
	act(() => {
		window.dispatchEvent(new Event("online"));
	});

	await waitFor(() => expect(api.confirm).toHaveBeenCalledTimes(1), {
		timeout: 1_000,
	});
});

it("uploads the whole chunk directly, as before, when the store can't be opened", async () => {
	render(tree(() => Promise.reject(new Error("IndexedDB unavailable"))));

	await act(() => recordChunk(slice(1, 2), slice(3)));
	await act(() => outbox.settled("conv-1"));

	expect(fallbackUpload).toHaveBeenCalledTimes(1);
	const [{ chunk, ...rest }] = fallbackUpload.mock.calls[0];
	expect(rest).toMatchObject({
		conversationId: "conv-1",
		source: "PORTAL_AUDIO",
		timestamp: new Date(STARTED_AT),
	});
	expect(chunk.type).toBe("audio/webm");
	expect(bytesOf(await chunk.arrayBuffer())).toEqual([1, 2, 3]);
	expect(api.upload).not.toHaveBeenCalled();
	expect(capture).toHaveBeenCalledWith(
		"portal_outbox_store_failed",
		expect.objectContaining({ stage: "open" }),
	);
});

it("counts a direct upload as queued until it's done", async () => {
	let finishUpload = () => {};
	fallbackUpload.mockReturnValue(
		new Promise<void>((resolve) => {
			finishUpload = resolve;
		}),
	);
	const { getByTestId } = render(
		tree(() => Promise.reject(new Error("IndexedDB unavailable"))),
	);

	await act(() => recordChunk());
	expect(getByTestId("count").textContent).toBe("1");

	await act(async () => finishUpload());
	await act(() => outbox.settled("conv-1"));
	expect(getByTestId("count").textContent).toBe("0");
});

it("counts a chunk from the moment it's sealed, before it's stored", async () => {
	render(tree());
	await act(() => outbox.settled("conv-1")); // the store is open

	let sealed: Promise<void> = Promise.resolve();
	act(() => {
		sealed = recordChunk();
	});

	expect(outbox.queuedCount("conv-1")).toBe(1);
	await act(() => sealed);
});

it("counts the whole session, not just what's queued now", async () => {
	render(tree());
	await act(() => recordChunk());
	await act(() => outbox.settled("conv-1"));
	await act(() => recordChunk());
	await act(() => outbox.settled("conv-1"));
	expect(outbox.progress("conv-1")).toEqual({ queued: 0, sent: 2, total: 2 });

	api.upload.mockImplementation(neverSettles);
	await act(() => recordChunk());
	await waitFor(() =>
		expect(outbox.progress("conv-1")).toEqual({ queued: 1, sent: 2, total: 3 }),
	);
});

it("counts a direct upload that landed as sent", async () => {
	render(tree(() => Promise.reject(new Error("IndexedDB unavailable"))));

	await act(() => recordChunk());
	await act(() => outbox.settled("conv-1"));

	expect(outbox.progress("conv-1")).toEqual({ queued: 0, sent: 1, total: 1 });
});

it("tells the conversation's listener a chunk was kept, and any limit it hit", async () => {
	api.confirm.mockResolvedValueOnce({ recording_stop: "audio_conversation" });
	render(tree());
	const conv1 = vi.fn();
	const conv2 = vi.fn();
	act(() => {
		outbox.onRecordingNotice("conv-1", conv1);
		outbox.onRecordingNotice("conv-2", conv2);
	});

	await act(() => recordChunk());
	await act(() => outbox.settled("conv-1"));

	expect(conv1).toHaveBeenCalledWith({
		accepted: true,
		recordedAt: STARTED_AT,
		stop: "audio_conversation",
	});
	expect(conv2).not.toHaveBeenCalled();
});

it("parks a chunk a recording limit refuses, says so once, and settles", async () => {
	api.upload.mockRejectedValueOnce(
		Object.assign(new Error("HTTP 402"), {
			isAxiosError: true,
			response: {
				data: { detail: { error: "FREE_TIER_LIMIT", limit: "ai_budget" } },
				status: 402,
			},
		}),
	);
	render(tree());
	const listener = vi.fn();
	act(() => {
		outbox.onRecordingNotice("conv-1", listener);
	});

	await act(() => recordChunk());
	await act(() => outbox.settled("conv-1"));

	expect(listener).toHaveBeenCalledTimes(1);
	expect(listener).toHaveBeenCalledWith({
		accepted: false,
		recordedAt: STARTED_AT,
		stop: "ai_budget",
	});
	expect(api.upload).toHaveBeenCalledTimes(1);
	// Kept on the device, but nothing waits on it: Finish isn't held up.
	expect(outbox.queuedCount("conv-1")).toBe(0);
	const store = await openSameStore();
	expect(await store.list()).toHaveLength(1);
	store.close();
});

it("keeps whole chunks only, as before, in a browser without Web Locks", async () => {
	Object.defineProperty(navigator, "locks", {
		configurable: true,
		value: undefined,
	});
	render(tree());
	const other = await openSameStore();

	const writer = begin();
	writer.append(slice(1, 2));
	writer.append(slice(3));
	await act(async () => {});
	// Nothing could ever recover these, or clear them away.
	expect(await other.listSliceGroups()).toEqual([]);

	await act(() => writer.seal());
	await act(() => outbox.settled("conv-1"));

	expect(api.upload).toHaveBeenCalledTimes(1);
	expect(bytesOf(api.upload.mock.calls[0][0].audio)).toEqual([1, 2, 3]);
	other.close();
});

describe("a chunk written a slice at a time", () => {
	it("keeps each slice on the device as it's recorded, before the chunk is sealed", async () => {
		render(tree());
		const store = await openSameStore();

		const writer = begin();
		writer.append(slice(1, 2));
		writer.append(slice(3));

		await waitFor(async () =>
			expect(await store.listSliceGroups()).toEqual([
				expect.objectContaining({
					bytes: 3,
					conversationId: "conv-1",
					sliceCount: 2,
					startedAt: STARTED_AT,
				}),
			]),
		);
		expect(api.upload).not.toHaveBeenCalled();
		store.close();
	});

	it("seals the slices into one chunk, timed from when recording began", async () => {
		render(tree());
		const writer = begin();
		writer.append(slice(1, 2));
		writer.append(slice(3, 4));
		writer.append(slice(5));
		vi.setSystemTime(new Date("2026-10-14T10:00:30.000Z"));

		await act(() => writer.seal());
		await act(() => outbox.settled("conv-1"));

		expect(api.upload).toHaveBeenCalledTimes(1);
		const [item] = api.upload.mock.calls[0];
		expect(bytesOf(item.audio)).toEqual([1, 2, 3, 4, 5]);
		expect(item).toMatchObject({
			conversationId: "conv-1",
			mimeType: "audio/webm",
			source: "PORTAL_AUDIO",
			timestamp: STARTED_AT,
		});
		expect(item.recovered).toBeUndefined();
		const store = await openSameStore();
		expect(await store.listSliceGroups()).toEqual([]);
		store.close();
	});

	it("waits in a settled() called right after the seal, until that chunk is sent", async () => {
		let sendUpload = () => {};
		api.upload.mockReturnValueOnce(
			new Promise((resolve) => {
				sendUpload = () =>
					resolve({ chunk_id: "c1", file_url: "https://s3/c1" });
			}),
		);
		render(tree());
		await act(() => outbox.settled("conv-1")); // the store is open
		const writer = begin();
		writer.append(slice(1, 2, 3));

		let settled = false;
		act(() => {
			void writer.seal();
			void outbox.settled("conv-1").then(() => {
				settled = true;
			});
		});
		await waitFor(() => expect(api.upload).toHaveBeenCalledTimes(1));
		expect(settled).toBe(false);

		await act(async () => sendUpload());
		await waitFor(() => expect(settled).toBe(true));
		expect(api.confirm).toHaveBeenCalledTimes(1);
	});

	it("isn't taken for a dead recording by another tab while it's still recording", async () => {
		render(tree());
		await act(() => outbox.settled("conv-1")); // this tab's drainer has started
		const store = await openSameStore();
		const writer = begin();
		writer.append(slice(...new Array(1200).fill(7)));
		await waitForSlices(store, 1);

		// Another tab opens, and its drainer looks for recordings that died mid-chunk.
		await createDrainer({ api, store }).start();

		expect(await store.listSliceGroups()).toHaveLength(1);
		expect(await store.list()).toEqual([]);
		await act(() => writer.seal());
		await act(() => outbox.settled("conv-1"));
		expect(api.upload).toHaveBeenCalledTimes(1);
		expect(api.upload.mock.calls[0][0].recovered).toBeUndefined();
		store.close();
	});

	it("is sent as recovered by the next page when its tab went away mid-chunk", async () => {
		const first = render(tree());
		const store = await openSameStore();
		const writer = begin();
		writer.append(slice(...new Array(800).fill(1)));
		writer.append(slice(...new Array(800).fill(2)));
		await waitForSlices(store, 2);
		store.close();

		first.unmount(); // never sealed
		render(tree());

		await waitFor(() => expect(api.confirm).toHaveBeenCalledTimes(1));
		const [item] = api.upload.mock.calls[0];
		expect(item).toMatchObject({
			conversationId: "conv-1",
			recovered: true,
			timestamp: STARTED_AT,
		});
		expect(item.audio.byteLength).toBe(1_600);
		expect(capture).toHaveBeenCalledWith(
			"portal_outbox_recovered",
			expect.objectContaining({ conversation_id: "conv-1", slices: 2 }),
		);
	});

	it("sends the whole chunk once, from memory, when a slice can't be stored", async () => {
		const openStore = async () => {
			const store = await openOutboxStore({ dbName });
			return {
				...store,
				appendSlice: (s: Parameters<OutboxStore["appendSlice"]>[0]) =>
					s.index === 1
						? Promise.reject(new Error("QuotaExceededError"))
						: store.appendSlice(s),
			};
		};
		render(tree(openStore));

		await act(() => recordChunk(slice(1, 2), slice(3, 4), slice(5)));
		await act(() => outbox.settled("conv-1"));

		expect(api.upload).toHaveBeenCalledTimes(1);
		expect(bytesOf(api.upload.mock.calls[0][0].audio)).toEqual([1, 2, 3, 4, 5]);
		// The slice that did land is gone, so no later page sends it again.
		const store = await openSameStore();
		expect(await store.listSliceGroups()).toEqual([]);
		store.close();
		expect(capture).toHaveBeenCalledWith(
			"portal_outbox_store_failed",
			expect.objectContaining({ stage: "append" }),
		);
	});
});
