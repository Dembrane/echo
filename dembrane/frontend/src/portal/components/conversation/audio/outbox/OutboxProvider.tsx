import { useQueryClient } from "@tanstack/react-query";
import posthog from "posthog-js";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useUploadConversationChunk } from "../hooks/useUploadConversationChunk";
import { createDrainer, type OutboxApi, type OutboxEvent } from "./drainOutbox";
import { outboxApi } from "./outboxApi";
import { type OutboxStore, openOutboxStore } from "./outboxStore";

/** Only one tab sends at a time; the others queue and wait their turn. */
const DRAIN_LOCK = "portal-audio-outbox";
/** Tells the other tabs the queue changed: wake up, recount. */
const CHANNEL = "portal-audio-outbox";
/** If a drain pass itself fails (IndexedDB trouble), try again after this. */
const DRAIN_ERROR_RETRY_MS = 60_000;

export type ChunkMeta = {
	conversationId: string;
	source: string;
	timestamp: Date;
};

export type Outbox = {
	/** Keeps the chunk on this device and sends it when it can. */
	enqueueChunk: (chunk: Blob, meta: ChunkMeta) => Promise<void>;
	/**
	 * Queues finishing the conversation behind its chunks, and resolves once
	 * the server has it, however long that takes. Aborting stops the wait and
	 * takes the finish back out of the queue, unless it's already being sent.
	 */
	finish: (
		conversationId: string,
		options?: { signal?: AbortSignal },
	) => Promise<void>;
	/** Chunks for this conversation still waiting to send. Re-renders on change. */
	queuedCount: (conversationId: string) => number;
	/** Resolves once nothing for this conversation is waiting to send. */
	settled: (conversationId: string) => Promise<void>;
};

const OutboxContext = createContext<Outbox | null>(null);

export const useOutbox = () => {
	const outbox = useContext(OutboxContext);
	if (!outbox) throw new Error("useOutbox needs an OutboxProvider");
	return outbox;
};

const aborted = (signal?: AbortSignal) =>
	signal?.reason ?? new DOMException("Aborted", "AbortError");

const errorMessage = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

const capture = (event: OutboxEvent) => {
	switch (event.type) {
		case "delivered":
			posthog.capture("portal_outbox_delivered", {
				age_ms: event.ageMs,
				attempts: event.attempts,
				conversation_id: event.item.conversationId,
				kind: event.item.kind,
				recovered: event.item.kind === "chunk" && !!event.item.recovered,
			});
			return;
		case "dropped":
			posthog.capture("portal_outbox_dropped", {
				conversation_id: event.item.conversationId,
				kind: event.item.kind,
				reason: event.reason,
			});
			return;
		case "discarded":
			posthog.capture("portal_outbox_dropped", {
				bytes: event.group.bytes,
				conversation_id: event.group.conversationId,
				kind: "slices",
				reason: event.reason,
			});
			return;
		case "recovered":
			posthog.capture("portal_outbox_recovered", {
				bytes: event.group.bytes,
				conversation_id: event.group.conversationId,
				slices: event.group.sliceCount,
			});
			return;
		case "retrying":
			// Once per item, not every retry: delivered/dropped carry the attempts.
			if (event.attempts === 1)
				posthog.capture("portal_outbox_retrying", {
					conversation_id: event.item.conversationId,
					error: errorMessage(event.error),
					kind: event.item.kind,
				});
			return;
	}
};

/**
 * Keeps the participant's audio on the device until the server has it, and
 * sends it from whichever portal page is open. Mounted once, in the layout.
 */
export const OutboxProvider = ({
	children,
	api = outboxApi,
	openStore = openOutboxStore,
}: {
	children: ReactNode;
	api?: OutboxApi;
	openStore?: () => Promise<OutboxStore>;
}) => {
	const queryClient = useQueryClient();
	// Today's in-memory upload, for when the store can't be used.
	const directUpload = useUploadConversationChunk();

	const storeRef = useRef<Promise<OutboxStore | null> | null>(null);
	const kickRef = useRef<() => void>(() => {});
	const retryNowRef = useRef<() => void>(() => {});
	const channelRef = useRef<BroadcastChannel | null>(null);
	const refreshRef = useRef<() => Promise<void>>(async () => {});

	// Counts live in a ref so waiters resolve the moment they change, not after
	// a render; the version only makes readers of queuedCount re-render.
	const counts = useRef({
		/** Finishes in the store. */
		finishes: {} as Record<string, number>,
		/** Handed over but not (or never to be) in the store: enqueuing, or direct uploads. */
		inMemory: {} as Record<string, number>,
		/** Chunks in the store. */
		stored: {} as Record<string, number>,
	});
	const [version, setVersion] = useState(0);
	const waiters = useRef(new Set<{ ready: () => boolean; done: () => void }>());

	const queued = useCallback(
		(conversationId: string) =>
			(counts.current.stored[conversationId] ?? 0) +
			(counts.current.inMemory[conversationId] ?? 0),
		[],
	);

	const countsChanged = useCallback(() => {
		setVersion((v) => v + 1);
		for (const waiter of waiters.current) {
			if (waiter.ready()) {
				waiters.current.delete(waiter);
				waiter.done();
			}
		}
	}, []);

	/** Resolves once `ready` holds, checked whenever the counts change. */
	const until = useCallback(
		(ready: () => boolean, signal?: AbortSignal) =>
			new Promise<void>((resolve, reject) => {
				if (signal?.aborted) return reject(aborted(signal));
				if (ready()) return resolve();
				const waiter = { done: resolve, ready };
				waiters.current.add(waiter);
				signal?.addEventListener(
					"abort",
					() => {
						waiters.current.delete(waiter);
						reject(aborted(signal));
					},
					{ once: true },
				);
			}),
		[],
	);

	useEffect(() => {
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let releaseLock = () => {};
		const lockAbort = new AbortController();

		const storePromise = openStore().catch((error) => {
			posthog.capture("portal_outbox_store_failed", {
				error: errorMessage(error),
				stage: "open",
			});
			return null;
		});
		storeRef.current = storePromise;

		const refresh = async () => {
			const store = await storePromise;
			if (!store || cancelled) return;
			const stored: Record<string, number> = {};
			const finishes: Record<string, number> = {};
			for (const item of await store.list()) {
				const tally = item.kind === "finish" ? finishes : stored;
				tally[item.conversationId] = (tally[item.conversationId] ?? 0) + 1;
			}
			if (cancelled) return;
			counts.current.stored = stored;
			counts.current.finishes = finishes;
			countsChanged();
		};
		refreshRef.current = refresh;

		const channel =
			typeof BroadcastChannel === "undefined"
				? null
				: new BroadcastChannel(CHANNEL);
		channelRef.current = channel;
		const announce = () => channel?.postMessage("changed");

		const onEvent = (event: OutboxEvent) => {
			capture(event);
			if (event.type === "delivered" && event.item.kind === "chunk") {
				const { conversationId } = event.item;
				queryClient.invalidateQueries({
					queryKey: ["conversations", conversationId],
				});
				queryClient.invalidateQueries({
					queryKey: ["participant", "conversation_chunks", conversationId],
				});
			}
			if (event.type !== "retrying") {
				void refresh();
				announce();
			}
		};

		// Only the tab holding the drain lock has a drainer; kicking elsewhere is a no-op.
		const becomeDrainer = async (store: OutboxStore) => {
			const drainer = createDrainer({ api, onEvent, store });
			const kick = async () => {
				clearTimeout(timer);
				try {
					const wait = await drainer.drain();
					if (!cancelled && wait !== null) timer = setTimeout(kick, wait);
				} catch (error) {
					console.error("[Outbox] drain failed", error);
					if (!cancelled) timer = setTimeout(kick, DRAIN_ERROR_RETRY_MS);
				}
			};
			kickRef.current = () => void kick();
			retryNowRef.current = () => {
				drainer.retryNow();
				void kick();
			};
			await drainer.start();
			void refresh();
			void kick();
		};

		void storePromise.then(async (store) => {
			if (!store || cancelled) return;
			void refresh();
			if (!navigator.locks?.request) {
				await becomeDrainer(store);
				return;
			}
			navigator.locks
				.request(DRAIN_LOCK, { signal: lockAbort.signal }, async () => {
					if (cancelled) return;
					await becomeDrainer(store);
					// Hold the lock until this provider goes away.
					await new Promise<void>((resolve) => {
						releaseLock = resolve;
					});
				})
				.catch(() => {}); // aborted on unmount
		});

		const wake = () => kickRef.current();
		// Failures while offline say nothing about the server: try again now.
		const onOnline = () => retryNowRef.current();
		const onVisible = () => {
			if (document.visibilityState === "visible") wake();
		};
		const onMessage = () => {
			void refresh();
			wake();
		};
		window.addEventListener("online", onOnline);
		document.addEventListener("visibilitychange", onVisible);
		channel?.addEventListener("message", onMessage);

		return () => {
			cancelled = true;
			clearTimeout(timer);
			kickRef.current = () => {};
			retryNowRef.current = () => {};
			window.removeEventListener("online", onOnline);
			document.removeEventListener("visibilitychange", onVisible);
			channel?.close();
			// Work still settling after unmount mustn't post to a closed channel.
			channelRef.current = null;
			lockAbort.abort();
			releaseLock();
			void storePromise.then((store) => store?.close());
		};
	}, [api, openStore, queryClient, countsChanged]);

	const enqueueChunk = useCallback(
		async (chunk: Blob, meta: ChunkMeta) => {
			// Counted from the moment it's handed over, before any await, so a
			// settled() right after never sees a gap before it's stored.
			const held = (by: number) => {
				const { inMemory } = counts.current;
				inMemory[meta.conversationId] =
					(inMemory[meta.conversationId] ?? 0) + by;
				countsChanged();
			};
			held(1);
			const store = await storeRef.current;
			if (store) {
				try {
					await store.enqueueChunk({
						audio: await chunk.arrayBuffer(),
						conversationId: meta.conversationId,
						mimeType: chunk.type,
						source: meta.source,
						timestamp: meta.timestamp.toISOString(),
					});
					posthog.capture("portal_outbox_enqueued", {
						bytes: chunk.size,
						conversation_id: meta.conversationId,
					});
					// Recount first, so the store's count takes over before ours drops.
					await refreshRef.current();
					held(-1);
					channelRef.current?.postMessage("changed");
					kickRef.current();
					return;
				} catch (error) {
					posthog.capture("portal_outbox_store_failed", {
						error: errorMessage(error),
						stage: "enqueue",
					});
				}
			}
			// No store: today's in-memory upload, still counted until it's done.
			void directUpload
				.mutateAsync({
					chunk,
					conversationId: meta.conversationId,
					runFinishHook: false,
					source: meta.source,
					timestamp: meta.timestamp,
				})
				.catch(() => {}) // the mutation reports its own failure
				.finally(() => held(-1));
		},
		[directUpload, countsChanged],
	);

	const finishWrites = useRef<Promise<void>>(Promise.resolve());

	const finishing = useCallback(
		(conversationId: string) =>
			(counts.current.finishes[conversationId] ?? 0) > 0,
		[],
	);

	const settled = useCallback(
		async (conversationId: string) => {
			await refreshRef.current();
			await until(
				() => queued(conversationId) === 0 && !finishing(conversationId),
			);
		},
		[queued, finishing, until],
	);

	const finish = useCallback(
		async (
			conversationId: string,
			{ signal }: { signal?: AbortSignal } = {},
		) => {
			// Chunks still on their way into the store, or uploading directly,
			// go first: the finish must queue behind every one of them.
			await until(
				() => (counts.current.inMemory[conversationId] ?? 0) === 0,
				signal,
			);
			const store = await storeRef.current;
			if (signal?.aborted) throw aborted(signal);

			if (!store) {
				// Nothing to queue it in: finish now, as before the outbox.
				await api.finish(conversationId);
				return;
			}

			// One finish per conversation: a second Finish joins the first. The
			// check and the write go one at a time, or two would both find none.
			const queueing = finishWrites.current.then(async () => {
				const items = await store.list();
				const queued = items.some(
					(item) =>
						item.kind === "finish" && item.conversationId === conversationId,
				);
				if (!queued) await store.enqueueFinish(conversationId);
			});
			finishWrites.current = queueing.catch(() => {});
			await queueing;
			await refreshRef.current();
			channelRef.current?.postMessage("changed");
			kickRef.current();

			// Taken back out unless the drainer has already sent it.
			const takeBack = async () => {
				for (const item of await store.list()) {
					if (item.kind === "finish" && item.conversationId === conversationId)
						await store.remove(item.seq);
				}
				await refreshRef.current();
				channelRef.current?.postMessage("changed");
			};
			if (signal?.aborted) {
				await takeBack();
				throw aborted(signal);
			}
			signal?.addEventListener("abort", () => void takeBack(), { once: true });
			// Gone from the queue: delivered, or dropped as the conversation is gone.
			await until(() => !finishing(conversationId), signal);
		},
		[api, finishing, until],
	);

	// A new value per version, so readers of queuedCount re-render.
	// biome-ignore lint/correctness/useExhaustiveDependencies: version is the point
	const value = useMemo<Outbox>(
		() => ({ enqueueChunk, finish, queuedCount: queued, settled }),
		[enqueueChunk, finish, queued, settled, version],
	);

	return (
		<OutboxContext.Provider value={value}>{children}</OutboxContext.Provider>
	);
};
