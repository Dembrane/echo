import "fake-indexeddb/auto";
import { beforeEach, expect, it } from "vitest";
import { type OutboxStore, openOutboxStore } from "./outboxStore";

let dbName: string;
let now: number;
let store: OutboxStore;

const open = () => openOutboxStore({ dbName, now: () => now });

const bytes = (...values: number[]) => new Uint8Array(values).buffer;
const asArray = (buffer: ArrayBuffer) => Array.from(new Uint8Array(buffer));

const slice = (groupId: string, index: number, audio: ArrayBuffer) => ({
	audio,
	conversationId: "conv-1",
	groupId,
	index,
	mimeType: "audio/webm",
	source: "PORTAL_AUDIO",
	startedAt: "2026-10-14T10:00:00.000Z",
});

beforeEach(async () => {
	// A fresh database per test, so nothing leaks between them.
	dbName = `outbox-test-${crypto.randomUUID()}`;
	now = 1_000;
	store = await open();
});

it("enqueues a chunk and gives its audio back intact", async () => {
	await store.enqueueChunk({
		audio: bytes(1, 2, 3),
		conversationId: "conv-1",
		mimeType: "audio/webm",
		source: "PORTAL_AUDIO",
		timestamp: "2026-10-14T10:00:00.000Z",
	});

	const [item] = await store.list();
	expect(item).toMatchObject({
		attempts: 0,
		conversationId: "conv-1",
		createdAt: 1_000,
		kind: "chunk",
		mimeType: "audio/webm",
		timestamp: "2026-10-14T10:00:00.000Z",
	});
	expect(item.kind === "chunk" && asArray(item.audio)).toEqual([1, 2, 3]);
});

it("lists chunks and finishes in the order they were enqueued", async () => {
	await store.enqueueChunk({
		audio: bytes(1),
		conversationId: "conv-1",
		mimeType: "audio/webm",
		source: "PORTAL_AUDIO",
		timestamp: "2026-10-14T10:00:00.000Z",
	});
	await store.enqueueFinish("conv-1");
	await store.enqueueChunk({
		audio: bytes(2),
		conversationId: "conv-2",
		mimeType: "audio/webm",
		source: "PORTAL_AUDIO",
		timestamp: "2026-10-14T10:00:30.000Z",
	});

	const items = await store.list();
	expect(items.map((i) => [i.kind, i.conversationId])).toEqual([
		["chunk", "conv-1"],
		["finish", "conv-1"],
		["chunk", "conv-2"],
	]);
	expect(items[0].seq).toBeLessThan(items[1].seq);
	expect(items[1].seq).toBeLessThan(items[2].seq);
});

it("seals a group's slices into one chunk, in slice order, and clears them", async () => {
	// Written out of order, as an index is what decides the order, not arrival.
	await store.appendSlice(slice("g1", 1, bytes(3, 4)));
	await store.appendSlice(slice("g1", 0, bytes(1, 2)));
	await store.appendSlice(slice("g1", 2, bytes(5)));

	const chunk = await store.sealGroup("g1");

	expect(chunk).toMatchObject({
		conversationId: "conv-1",
		kind: "chunk",
		mimeType: "audio/webm",
		source: "PORTAL_AUDIO",
		timestamp: "2026-10-14T10:00:00.000Z",
	});
	expect(chunk?.recovered).toBeUndefined();
	const [item] = await store.list();
	expect(item.kind === "chunk" && asArray(item.audio)).toEqual([1, 2, 3, 4, 5]);
	expect(await store.listSliceGroups()).toEqual([]);
});

it("marks a chunk sealed after a crash as recovered", async () => {
	await store.appendSlice(slice("g1", 0, bytes(1)));

	const chunk = await store.sealGroup("g1", { recovered: true });

	expect(chunk?.recovered).toBe(true);
});

it("seals nothing for a group with no slices", async () => {
	expect(await store.sealGroup("missing")).toBeNull();
	expect(await store.list()).toEqual([]);
});

it("sealing one group leaves the others' slices alone", async () => {
	await store.appendSlice(slice("g1", 0, bytes(1)));
	await store.appendSlice(slice("g2", 0, bytes(2)));

	await store.sealGroup("g1");

	expect((await store.listSliceGroups()).map((g) => g.groupId)).toEqual(["g2"]);
});

it("summarises slice groups without sealing them", async () => {
	await store.appendSlice(slice("g1", 0, bytes(1, 2)));
	await store.appendSlice(slice("g1", 1, bytes(3)));
	await store.appendSlice({
		...slice("g2", 0, bytes(4)),
		conversationId: "conv-2",
	});

	expect(await store.listSliceGroups()).toEqual([
		{
			bytes: 3,
			conversationId: "conv-1",
			groupId: "g1",
			sliceCount: 2,
			startedAt: "2026-10-14T10:00:00.000Z",
		},
		{
			bytes: 1,
			conversationId: "conv-2",
			groupId: "g2",
			sliceCount: 1,
			startedAt: "2026-10-14T10:00:00.000Z",
		},
	]);
});

it("discards one group's slices without enqueueing anything", async () => {
	await store.appendSlice(slice("g1", 0, bytes(1)));
	await store.appendSlice(slice("g2", 0, bytes(2)));

	await store.discardGroup("g1");

	expect((await store.listSliceGroups()).map((g) => g.groupId)).toEqual(["g2"]);
	expect(await store.list()).toEqual([]);
});

it("remembers an upload and counts attempts on an item", async () => {
	const { seq } = await store.enqueueChunk({
		audio: bytes(1),
		conversationId: "conv-1",
		mimeType: "audio/webm",
		source: "PORTAL_AUDIO",
		timestamp: "2026-10-14T10:00:00.000Z",
	});

	await store.markUploaded(seq, { chunk_id: "c1", file_url: "https://s3/c1" });
	await store.noteAttempt(seq);
	await store.noteAttempt(seq);

	const [item] = await store.list();
	expect(item).toMatchObject({
		attempts: 2,
		uploaded: { chunk_id: "c1", file_url: "https://s3/c1" },
	});
});

it("removes an item", async () => {
	const { seq } = await store.enqueueFinish("conv-1");

	await store.remove(seq);

	expect(await store.list()).toEqual([]);
});

it("purges items older than a cutoff and returns them", async () => {
	await store.enqueueFinish("old");
	now = 5_000;
	await store.enqueueFinish("new");

	const purged = await store.purgeOlderThan(5_000);

	expect(purged.map((i) => i.conversationId)).toEqual(["old"]);
	expect((await store.list()).map((i) => i.conversationId)).toEqual(["new"]);
});

it("keeps everything across a reopen, as after a reload", async () => {
	await store.enqueueFinish("conv-1");
	await store.appendSlice(slice("g1", 0, bytes(1)));
	store.close();

	const reopened = await open();

	expect((await reopened.list()).map((i) => i.conversationId)).toEqual([
		"conv-1",
	]);
	expect((await reopened.listSliceGroups()).map((g) => g.groupId)).toEqual([
		"g1",
	]);
	reopened.close();
});
