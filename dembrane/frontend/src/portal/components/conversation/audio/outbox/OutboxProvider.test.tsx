// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, type Mock, vi } from "vitest";
import type { OutboxApi } from "./drainOutbox";
import { type Outbox, OutboxProvider, useOutbox } from "./OutboxProvider";
import { openOutboxStore } from "./outboxStore";

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

let dbName: string;
let api: { [K in keyof OutboxApi]: Mock<OutboxApi[K]> };
let outbox: Outbox;

const Capture = () => {
	outbox = useOutbox();
	return <span data-testid="count">{outbox.queuedCount("conv-1")}</span>;
};

const tree = (
	openStore: () => ReturnType<typeof openOutboxStore> = () =>
		openOutboxStore({ dbName }),
): ReactNode => (
	<QueryClientProvider client={new QueryClient()}>
		<OutboxProvider api={api} openStore={openStore}>
			<Capture />
		</OutboxProvider>
	</QueryClientProvider>
);

const chunk = () =>
	new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
const meta = {
	conversationId: "conv-1",
	source: "PORTAL_AUDIO",
	timestamp: new Date("2026-10-14T10:00:00.000Z"),
};

const neverSettles = () => new Promise<never>(() => {});

beforeEach(() => {
	dbName = `provider-test-${crypto.randomUUID()}`;
	api = {
		confirm: vi.fn<OutboxApi["confirm"]>().mockResolvedValue(undefined),
		finish: vi.fn<OutboxApi["finish"]>().mockResolvedValue(undefined),
		upload: vi
			.fn<OutboxApi["upload"]>()
			.mockResolvedValue({ chunk_id: "c1", file_url: "https://s3/c1" }),
	};
	fallbackUpload.mockResolvedValue({});
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

it("sends an enqueued chunk and settles once it's confirmed", async () => {
	const { getByTestId } = render(tree());

	await act(() => outbox.enqueueChunk(chunk(), meta));
	await act(() => outbox.settled("conv-1"));

	expect(api.upload).toHaveBeenCalledWith(
		expect.objectContaining({
			conversationId: "conv-1",
			mimeType: "audio/webm",
			source: "PORTAL_AUDIO",
			timestamp: "2026-10-14T10:00:00.000Z",
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

	await act(() => outbox.enqueueChunk(chunk(), meta));

	await waitFor(() => expect(getByTestId("count").textContent).toBe("1"));
});

it("keeps a chunk it couldn't send across a reload, and sends it then", async () => {
	api.upload.mockRejectedValue(new Error("Network Error"));
	const first = render(tree());
	await act(() => outbox.enqueueChunk(chunk(), meta));
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
	await act(() => outbox.enqueueChunk(chunk(), meta));
	await waitFor(() => expect(api.upload).toHaveBeenCalledTimes(1));

	// Well inside the 2s backoff, so only the online event can explain a retry.
	act(() => {
		window.dispatchEvent(new Event("online"));
	});

	await waitFor(() => expect(api.confirm).toHaveBeenCalledTimes(1), {
		timeout: 1_000,
	});
});

it("uploads directly, as before, when the store can't be opened", async () => {
	render(tree(() => Promise.reject(new Error("IndexedDB unavailable"))));

	await act(() => outbox.enqueueChunk(chunk(), meta));
	await act(() => outbox.settled("conv-1"));

	expect(fallbackUpload).toHaveBeenCalledWith(
		expect.objectContaining({
			conversationId: "conv-1",
			source: "PORTAL_AUDIO",
		}),
	);
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

	await act(() => outbox.enqueueChunk(chunk(), meta));
	expect(getByTestId("count").textContent).toBe("1");

	await act(async () => finishUpload());
	await act(() => outbox.settled("conv-1"));
	expect(getByTestId("count").textContent).toBe("0");
});

it("counts a chunk from the moment it's handed over, before it's stored", async () => {
	render(tree());
	await act(() => outbox.settled("conv-1")); // the store is open

	let enqueued: Promise<void> = Promise.resolve();
	act(() => {
		enqueued = outbox.enqueueChunk(chunk(), meta);
	});

	expect(outbox.queuedCount("conv-1")).toBe(1);
	await act(() => enqueued);
});

it("finishes behind the conversation's chunks, and resolves once it's delivered", async () => {
	const order: string[] = [];
	api.confirm.mockImplementation(async () => {
		order.push("confirm");
	});
	api.finish.mockImplementation(async () => {
		order.push("finish");
	});
	render(tree());

	let enqueued: Promise<void> = Promise.resolve();
	act(() => {
		enqueued = outbox.enqueueChunk(chunk(), meta);
	});
	await act(() => outbox.finish("conv-1"));
	await act(() => enqueued);

	expect(order).toEqual(["confirm", "finish"]);
	expect(capture).toHaveBeenCalledWith(
		"portal_outbox_delivered",
		expect.objectContaining({ conversation_id: "conv-1", kind: "finish" }),
	);
});

it("counts chunks, not the finish, as queued", async () => {
	api.upload.mockImplementation(neverSettles);
	const { getByTestId } = render(tree());

	await act(() => outbox.enqueueChunk(chunk(), meta));
	let finished: Promise<void> = Promise.resolve();
	act(() => {
		finished = outbox.finish("conv-1");
	});
	// Still waiting when the test ends, and the store closes under it.
	finished.catch(() => {});

	await waitFor(() => expect(outbox.queuedCount("conv-1")).toBe(1));
	await waitFor(async () => {
		const store = await openOutboxStore({ dbName });
		const kinds = (await store.list()).map((item) => item.kind);
		store.close();
		expect(kinds).toEqual(["chunk", "finish"]);
	});
	expect(getByTestId("count").textContent).toBe("1");
});

it("sends one finish when Finish is pressed twice", async () => {
	render(tree());

	await act(() =>
		Promise.all([outbox.finish("conv-1"), outbox.finish("conv-1")]),
	);

	expect(api.finish).toHaveBeenCalledTimes(1);
});

it("takes a waiting finish back out when it's aborted", async () => {
	api.upload.mockImplementation(neverSettles);
	render(tree());
	await act(() => outbox.enqueueChunk(chunk(), meta));

	const abort = new AbortController();
	let finished: Promise<void> = Promise.resolve();
	act(() => {
		finished = outbox.finish("conv-1", { signal: abort.signal });
	});
	await waitFor(async () => {
		const store = await openOutboxStore({ dbName });
		const kinds = (await store.list()).map((item) => item.kind);
		store.close();
		expect(kinds).toEqual(["chunk", "finish"]);
	});

	act(() => abort.abort());
	await expect(finished).rejects.toThrow();

	await waitFor(async () => {
		const store = await openOutboxStore({ dbName });
		const kinds = (await store.list()).map((item) => item.kind);
		store.close();
		expect(kinds).toEqual(["chunk"]);
	});
	expect(api.finish).not.toHaveBeenCalled();
});

it("finishes directly, after its direct uploads, when the store can't be opened", async () => {
	let finishUpload = () => {};
	fallbackUpload.mockReturnValue(
		new Promise<void>((resolve) => {
			finishUpload = resolve;
		}),
	);
	render(tree(() => Promise.reject(new Error("IndexedDB unavailable"))));
	await act(() => outbox.enqueueChunk(chunk(), meta));

	let finished: Promise<void> = Promise.resolve();
	act(() => {
		finished = outbox.finish("conv-1");
	});
	await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
	expect(api.finish).not.toHaveBeenCalled();

	await act(async () => finishUpload());
	await act(() => finished);
	expect(api.finish).toHaveBeenCalledWith("conv-1");
});
