import "fake-indexeddb/auto";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type Mock,
	vi,
} from "vitest";
import {
	createDrainer,
	type Drainer,
	type OutboxApi,
	type OutboxEvent,
	recordingLockName,
} from "./drainOutbox";
import { type OutboxStore, openOutboxStore } from "./outboxStore";

const DAY_MS = 24 * 60 * 60 * 1000;

let now: number;
let store: OutboxStore;
let events: OutboxEvent[];
let api: { [K in keyof OutboxApi]: Mock<OutboxApi[K]> };
let drainer: Drainer;

const httpError = (status: number) =>
	Object.assign(new Error(`HTTP ${status}`), {
		isAxiosError: true,
		response: { status },
	});

const enqueueChunk = (conversationId: string, byte = 1) =>
	store.enqueueChunk({
		audio: new Uint8Array([byte]).buffer,
		conversationId,
		mimeType: "audio/webm",
		source: "PORTAL_AUDIO",
		timestamp: "2026-10-14T10:00:00.000Z",
	});

/** What the API was asked to do, in order, as short labels. */
const calls = () =>
	[
		...api.upload.mock.calls.map(([item], i) => ({
			label: `upload ${item.conversationId}#${new Uint8Array(item.audio)[0]}`,
			order: api.upload.mock.invocationCallOrder[i],
		})),
		...api.confirm.mock.calls.map(([item], i) => ({
			label: `confirm ${item.conversationId}#${new Uint8Array(item.audio)[0]}`,
			order: api.confirm.mock.invocationCallOrder[i],
		})),
		...api.finish.mock.calls.map(([conversationId], i) => ({
			label: `finish ${conversationId}`,
			order: api.finish.mock.invocationCallOrder[i],
		})),
	]
		.sort((a, b) => a.order - b.order)
		.map((c) => c.label);

beforeEach(async () => {
	now = 1_000_000;
	store = await openOutboxStore({
		dbName: `drain-test-${crypto.randomUUID()}`,
		now: () => now,
	});
	events = [];
	api = {
		confirm: vi.fn<OutboxApi["confirm"]>().mockResolvedValue(undefined),
		finish: vi.fn<OutboxApi["finish"]>().mockResolvedValue(undefined),
		upload: vi
			.fn<OutboxApi["upload"]>()
			.mockResolvedValue({ chunk_id: "c1", file_url: "https://s3/c1" }),
	};
	drainer = createDrainer({
		api,
		now: () => now,
		onEvent: (e) => events.push(e),
		store,
	});
});

afterEach(() => store.close());

it("uploads, confirms and removes a chunk", async () => {
	await enqueueChunk("conv-1");
	now += 5_000;

	expect(await drainer.drain()).toBeNull();

	expect(calls()).toEqual(["upload conv-1#1", "confirm conv-1#1"]);
	expect(api.confirm).toHaveBeenCalledWith(expect.anything(), {
		chunk_id: "c1",
		file_url: "https://s3/c1",
	});
	expect(await store.list()).toEqual([]);
	expect(events).toEqual([
		expect.objectContaining({ ageMs: 5_000, attempts: 1, type: "delivered" }),
	]);
});

it("sends a conversation's chunks in order, then its finish", async () => {
	await enqueueChunk("conv-1", 1);
	await enqueueChunk("conv-1", 2);
	await store.enqueueFinish("conv-1");

	await drainer.drain();

	expect(calls()).toEqual([
		"upload conv-1#1",
		"confirm conv-1#1",
		"upload conv-1#2",
		"confirm conv-1#2",
		"finish conv-1",
	]);
	expect(await store.list()).toEqual([]);
});

it("only re-confirms a chunk S3 already has", async () => {
	const { seq } = await enqueueChunk("conv-1");
	await store.markUploaded(seq, { chunk_id: "c9", file_url: "https://s3/c9" });

	await drainer.drain();

	expect(api.upload).not.toHaveBeenCalled();
	expect(api.confirm).toHaveBeenCalledWith(expect.anything(), {
		chunk_id: "c9",
		file_url: "https://s3/c9",
	});
});

it("remembers a finished upload when the confirm fails, even across a reload", async () => {
	await enqueueChunk("conv-1");
	api.confirm.mockRejectedValueOnce(new Error("Network Error"));

	await drainer.drain();
	// A new drainer, as after a reload, with the clock past the backoff.
	now += 60_000;
	const after = createDrainer({ api, now: () => now, store });
	await after.drain();

	expect(api.upload).toHaveBeenCalledTimes(1);
	expect(api.confirm).toHaveBeenCalledTimes(2);
	expect(await store.list()).toEqual([]);
});

it("uploads again when confirm says S3 doesn't have the file", async () => {
	await enqueueChunk("conv-1");
	api.confirm.mockRejectedValueOnce(httpError(400));

	await drainer.drain();
	now += 60_000;
	await drainer.drain();

	expect(api.upload).toHaveBeenCalledTimes(2);
	expect(await store.list()).toEqual([]);
});

it("backs off 2s, doubling to a 60s cap, and never gives up", async () => {
	await enqueueChunk("conv-1");
	api.upload.mockRejectedValue(new Error("Network Error"));

	const waits: (number | null)[] = [];
	for (let i = 0; i < 8; i++) {
		waits.push(await drainer.drain());
		now += waits.at(-1) ?? 0;
	}

	expect(waits).toEqual([
		2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000,
	]);
	expect(api.upload).toHaveBeenCalledTimes(8);
	expect(await store.list()).toHaveLength(1);
	expect(events.at(-1)).toMatchObject({ attempts: 8, type: "retrying" });
});

it("doesn't retry before the backoff is up", async () => {
	await enqueueChunk("conv-1");
	api.upload.mockRejectedValueOnce(new Error("Network Error"));

	await drainer.drain();
	now += 1_000;

	expect(await drainer.drain()).toBe(1_000);
	expect(api.upload).toHaveBeenCalledTimes(1);
});

it("treats a server error as worth retrying", async () => {
	await enqueueChunk("conv-1");
	api.upload.mockRejectedValueOnce(httpError(500));

	expect(await drainer.drain()).toBe(2_000);
	expect(await store.list()).toHaveLength(1);
});

it("succeeding resets the backoff", async () => {
	await enqueueChunk("conv-1", 1);
	await enqueueChunk("conv-1", 2);
	api.upload
		.mockRejectedValueOnce(new Error("Network Error"))
		.mockRejectedValueOnce(new Error("Network Error"));
	await drainer.drain();
	now += 2_000;
	await drainer.drain();
	now += 4_000;
	await drainer.drain(); // chunk 1 lands, chunk 2 follows straight away

	api.upload.mockRejectedValueOnce(new Error("Network Error"));
	await enqueueChunk("conv-1", 3);

	expect(await drainer.drain()).toBe(2_000);
});

it("doesn't let one stuck conversation hold up another", async () => {
	await enqueueChunk("stuck", 1);
	await enqueueChunk("fine", 2);
	api.upload.mockImplementation(async (item) => {
		if (item.conversationId === "stuck") throw httpError(500);
		return { chunk_id: "c2", file_url: "https://s3/c2" };
	});

	await drainer.drain();

	expect(await store.list()).toEqual([
		expect.objectContaining({ conversationId: "stuck" }),
	]);
	expect(api.confirm).toHaveBeenCalledTimes(1);
});

it("holds a finish back while its conversation's chunk is still failing", async () => {
	await enqueueChunk("conv-1");
	await store.enqueueFinish("conv-1");
	api.upload.mockRejectedValue(new Error("Network Error"));

	await drainer.drain();
	now += 2_000;
	await drainer.drain();

	expect(api.finish).not.toHaveBeenCalled();
});

it.each([403, 404, 410])(
	"drops an item the server answers %i to, and moves on",
	async (status) => {
		await enqueueChunk("gone", 1);
		await store.enqueueFinish("gone");
		api.upload.mockRejectedValueOnce(httpError(status));
		api.finish.mockRejectedValueOnce(httpError(status));

		expect(await drainer.drain()).toBeNull();

		expect(await store.list()).toEqual([]);
		expect(events.map((e) => e.type === "dropped" && e.reason)).toEqual([
			`http_${status}`,
			`http_${status}`,
		]);
	},
);

it("drops items older than 7 days when it starts", async () => {
	await enqueueChunk("old");
	now += 7 * DAY_MS + 1;
	await enqueueChunk("new");

	await drainer.start();

	expect((await store.list()).map((i) => i.conversationId)).toEqual(["new"]);
	expect(events).toEqual([
		expect.objectContaining({ reason: "expired", type: "dropped" }),
	]);
});

it("runs one pass at a time however often it's woken", async () => {
	await enqueueChunk("conv-1");

	await Promise.all([drainer.drain(), drainer.drain(), drainer.drain()]);

	expect(api.upload).toHaveBeenCalledTimes(1);
	expect(api.confirm).toHaveBeenCalledTimes(1);
});

it("picks up an item enqueued while a pass is running", async () => {
	await enqueueChunk("conv-1", 1);
	let release = () => {};
	api.upload.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				release = () => resolve({ chunk_id: "c1", file_url: "https://s3/c1" });
			}),
	);

	const first = drainer.drain();
	await vi.waitFor(() => expect(api.upload).toHaveBeenCalled());
	await enqueueChunk("conv-2", 2);
	const second = drainer.drain();
	release();
	await Promise.all([first, second]);

	expect(await store.list()).toEqual([]);
	expect(calls()).toContain("confirm conv-2#2");
});

describe("slices left behind by a tab that died mid-chunk", () => {
	const appendSlices = async (
		groupId: string,
		sizes: number[],
		startedAt = now,
	) => {
		for (const [index, size] of sizes.entries()) {
			await store.appendSlice({
				audio: new Uint8Array(size).fill(index + 1).buffer,
				conversationId: "conv-1",
				groupId,
				index,
				mimeType: "audio/webm",
				source: "PORTAL_AUDIO",
				startedAt: new Date(startedAt).toISOString(),
			});
		}
	};

	const startWithLocksHeld = (...groupIds: string[]) =>
		createDrainer({
			api,
			heldLocks: async () => new Set(groupIds.map(recordingLockName)),
			now: () => now,
			onEvent: (e) => events.push(e),
			store,
		}).start();

	it("seals a group nobody is recording any more as a recovered chunk", async () => {
		await appendSlices("dead", [800, 800]);

		await startWithLocksHeld();

		expect(await store.listSliceGroups()).toEqual([]);
		const [item] = await store.list();
		expect(item).toMatchObject({ conversationId: "conv-1", recovered: true });
		expect(item.kind === "chunk" && item.audio.byteLength).toBe(1_600);
		expect(events).toEqual([
			expect.objectContaining({
				group: expect.objectContaining({ groupId: "dead", sliceCount: 2 }),
				type: "recovered",
			}),
		]);
	});

	it("leaves a group alone while a tab still holds its recording lock", async () => {
		await appendSlices("live", [800, 800]);

		await startWithLocksHeld("live");

		expect((await store.listSliceGroups()).map((g) => g.groupId)).toEqual([
			"live",
		]);
		expect(await store.list()).toEqual([]);
	});

	it("discards a dead group too small to hold any audio", async () => {
		// An MP4 recording's first slice is only its header, about 600 bytes.
		await appendSlices("header-only", [641]);

		await startWithLocksHeld();

		expect(await store.listSliceGroups()).toEqual([]);
		expect(await store.list()).toEqual([]);
		expect(events).toEqual([
			expect.objectContaining({ reason: "empty", type: "discarded" }),
		]);
	});

	it("discards a dead group that started over 7 days ago", async () => {
		await appendSlices("ancient", [800, 800], now - 7 * DAY_MS - 1);

		await startWithLocksHeld();

		expect(await store.listSliceGroups()).toEqual([]);
		expect(await store.list()).toEqual([]);
		expect(events).toEqual([
			expect.objectContaining({ reason: "expired", type: "discarded" }),
		]);
	});

	it("leaves every group alone when the browser can't say which locks are held", async () => {
		await appendSlices("unknown", [800, 800]);

		await createDrainer({ api, heldLocks: async () => null, store }).start();

		expect((await store.listSliceGroups()).map((g) => g.groupId)).toEqual([
			"unknown",
		]);
	});

	it("sends the recovered chunk like any other", async () => {
		await appendSlices("dead", [800, 800]);

		await startWithLocksHeld();
		await drainer.drain();

		expect(api.upload).toHaveBeenCalledTimes(1);
		expect(await store.list()).toEqual([]);
	});
});
