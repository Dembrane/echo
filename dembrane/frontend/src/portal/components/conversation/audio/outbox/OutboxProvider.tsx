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
import {
	portalRecordingRefusal,
	type RecordingRefusal,
	recordingStopOf,
} from "@/lib/freeTier";
import type { ChunkSink } from "../hooks/useChunkedAudioRecorder";
import { useUploadConversationChunk } from "../hooks/useUploadConversationChunk";
import type { OutboxApi, OutboxEvent } from "./drainOutbox";
import type { OutboxStore } from "./outboxStore";
import { holdRecordingLock } from "./recordingLock";

// The store, drainer and API load after the first screen: the portal's first
// load has a size budget (scripts/check-portal-bundle.mjs), and nothing here
// is needed before a chunk exists or the page has settled.
const openOutboxStore = () =>
	import("./outboxStore").then((m) => m.openOutboxStore());
const loadOutboxApi = () => import("./outboxApi").then((m) => m.outboxApi);

/** Only one tab sends at a time; the others queue and wait their turn. */
const DRAIN_LOCK = "portal-audio-outbox";
/** Tells the other tabs the queue changed: wake up, recount. */
const CHANNEL = "portal-audio-outbox";
/** If a drain pass itself fails (IndexedDB trouble), try again after this. */
const DRAIN_ERROR_RETRY_MS = 60_000;

export type ChunkMeta = {
	conversationId: string;
	source: string;
};

/**
 * What the server said about a conversation's audio. accepted: the chunk was
 * kept. stop: a recording limit was hit, so the recording has to end.
 */
export type RecordingNotice = {
	accepted: boolean;
	stop: RecordingRefusal | null;
	/** When the chunk was recorded (ISO), so a screen can tell its own audio from an earlier page's. */
	recordedAt: string;
};

type NoticeMessage = { conversationId: string; notice: RecordingNotice };

/** The notice a drainer event carries for the recording screen, if any. */
const noticeOf = (event: OutboxEvent): NoticeMessage | null => {
	if (event.type === "delivered")
		return {
			conversationId: event.item.conversationId,
			notice: {
				accepted: true,
				recordedAt: event.item.timestamp,
				stop: recordingStopOf(event.response),
			},
		};
	// Only the first refusal: a parked chunk refused again on a later try says nothing new.
	if (event.type === "parked" && !event.again) {
		const stop = portalRecordingRefusal(event.error);
		if (stop)
			return {
				conversationId: event.item.conversationId,
				notice: { accepted: false, recordedAt: event.item.timestamp, stop },
			};
	}
	return null;
};

export type Outbox = {
	/**
	 * Where a recorder writes this conversation's audio. Each slice is kept on
	 * this device as it's recorded, so a crash loses at most the last one, and
	 * each sealed chunk is sent when it can be.
	 */
	openChunkSink: (meta: ChunkMeta) => ChunkSink;
	/** Items for this conversation still waiting to send. Re-renders on change. */
	queuedCount: (conversationId: string) => number;
	/**
	 * This conversation's chunks since the page loaded: `sent` of `total`,
	 * with `queued` still waiting. Re-renders on change.
	 */
	progress: (conversationId: string) => OutboxProgress;
	/** Resolves once nothing for this conversation is waiting to send. */
	settled: (conversationId: string) => Promise<void>;
	/**
	 * Calls back with what the server says about this conversation's audio,
	 * from whichever tab sends it. Returns the unsubscribe.
	 */
	onRecordingNotice: (
		conversationId: string,
		listener: (notice: RecordingNotice) => void,
	) => () => void;
};

export type OutboxProgress = { queued: number; sent: number; total: number };

const OutboxContext = createContext<Outbox | null>(null);

export const useOutbox = () => {
	const outbox = useContext(OutboxContext);
	if (!outbox) throw new Error("useOutbox needs an OutboxProvider");
	return outbox;
};

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
				// It had been parked: a limit lifted and the audio landed later.
				parked: !!event.item.parked,
				recovered: !!event.item.recovered,
			});
			return;
		case "parked":
			// Once per chunk, not every hourly retry.
			if (!event.again)
				posthog.capture("portal_outbox_parked", {
					conversation_id: event.item.conversationId,
					error: errorMessage(event.error),
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
	api,
	openStore = openOutboxStore,
}: {
	children: ReactNode;
	api?: OutboxApi;
	openStore?: () => Promise<OutboxStore>;
}) => {
	const queryClient = useQueryClient();

	const noticeListeners = useRef(
		new Set<{
			conversationId: string;
			listener: (notice: RecordingNotice) => void;
		}>(),
	);
	const notify = useCallback(({ conversationId, notice }: NoticeMessage) => {
		for (const entry of noticeListeners.current)
			if (entry.conversationId === conversationId) entry.listener(notice);
	}, []);

	// Today's in-memory upload, for when the store can't be used. Its callbacks
	// don't say which conversation, so notices go to the one it last sent for.
	const directConversationRef = useRef("");
	const { mutateAsync: uploadDirectly } = useUploadConversationChunk({
		onChunkAccepted: () =>
			notify({
				conversationId: directConversationRef.current,
				notice: {
					accepted: true,
					recordedAt: new Date().toISOString(),
					stop: null,
				},
			}),
		onRecordingStop: (stop, accepted) =>
			notify({
				conversationId: directConversationRef.current,
				notice: { accepted, recordedAt: new Date().toISOString(), stop },
			}),
	});

	const storeRef = useRef<Promise<OutboxStore | null> | null>(null);
	const kickRef = useRef<() => void>(() => {});
	const retryNowRef = useRef<() => void>(() => {});
	const channelRef = useRef<BroadcastChannel | null>(null);
	const refreshRef = useRef<(alongside?: () => void) => Promise<void>>(
		async () => {},
	);
	/** Releases the recording lock of each slice group still being written. */
	const recordingLocks = useRef(new Set<() => void>());

	// Counts live in a ref so waiters resolve the moment they change, not after
	// a render; the version only makes readers of queuedCount re-render.
	const counts = useRef({
		/** Direct uploads that landed: the session total keeps them. */
		directSent: {} as Record<string, number>,
		/** Handed over but not (or never to be) in the store: enqueuing, or direct uploads. */
		inMemory: {} as Record<string, number>,
		/** Every stored item seen since the page loaded, by seq: the session total. */
		seen: {} as Record<string, Set<number>>,
		stored: {} as Record<string, number>,
	});
	const [version, setVersion] = useState(0);
	const waiters = useRef(
		new Set<{ conversationId: string; done: () => void }>(),
	);

	const queued = useCallback(
		(conversationId: string) =>
			(counts.current.stored[conversationId] ?? 0) +
			(counts.current.inMemory[conversationId] ?? 0),
		[],
	);

	const countsChanged = useCallback(() => {
		setVersion((v) => v + 1);
		for (const waiter of waiters.current) {
			if (queued(waiter.conversationId) === 0) {
				waiters.current.delete(waiter);
				waiter.done();
			}
		}
	}, [queued]);

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

		// `alongside` changes the counts in the same update as the recount, so
		// no reader sees the queue in between.
		const refresh = async (alongside?: () => void) => {
			const store = await storePromise;
			if (!store || cancelled) return;
			const items = await store.list();
			if (cancelled) return;
			const next: Record<string, number> = {};
			const { seen } = counts.current;
			for (const item of items) {
				// Parked audio waits on a limit, not the network: nothing waits on
				// it, and progress doesn't count it as sent.
				if (item.parked) {
					seen[item.conversationId]?.delete(item.seq);
					continue;
				}
				next[item.conversationId] = (next[item.conversationId] ?? 0) + 1;
				seen[item.conversationId] ??= new Set();
				seen[item.conversationId].add(item.seq);
			}
			counts.current.stored = next;
			alongside?.();
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
			const message = noticeOf(event);
			if (message) {
				notify(message);
				// The screen recording this conversation may be in another tab.
				channel?.postMessage(message);
			}
			if (event.type === "delivered") {
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
			const [{ createDrainer }, drainApi] = await Promise.all([
				import("./drainOutbox"),
				api ?? loadOutboxApi(),
			]);
			if (cancelled) return;
			const drainer = createDrainer({ api: drainApi, onEvent, store });
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
		const onMessage = ({ data }: MessageEvent<"changed" | NoticeMessage>) => {
			if (data !== "changed") {
				notify(data);
				return;
			}
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
			for (const release of recordingLocks.current) release();
			void storePromise.then((store) => store?.close());
		};
	}, [api, openStore, queryClient, countsChanged, notify]);

	// A chunk is counted from the moment it's handed over, before any await,
	// so a settled() right after never sees a gap before it's stored.
	const hold = useCallback((conversationId: string, by: number) => {
		const { inMemory } = counts.current;
		inMemory[conversationId] = (inMemory[conversationId] ?? 0) + by;
	}, []);

	const handedToStore = useCallback(
		async (conversationId: string, bytes: number) => {
			posthog.capture("portal_outbox_enqueued", {
				bytes,
				conversation_id: conversationId,
			});
			// The store's count takes over in the same update ours drops.
			await refreshRef.current(() => hold(conversationId, -1));
			channelRef.current?.postMessage("changed");
			kickRef.current();
		},
		[hold],
	);

	/** A whole chunk: what a chunk sink falls back to when its slices can't be stored. */
	const enqueueChunk = useCallback(
		async (chunk: Blob, meta: ChunkMeta & { timestamp: Date }) => {
			hold(meta.conversationId, 1);
			countsChanged();
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
					await handedToStore(meta.conversationId, chunk.size);
					return;
				} catch (error) {
					posthog.capture("portal_outbox_store_failed", {
						error: errorMessage(error),
						stage: "enqueue",
					});
				}
			}
			// No store: today's in-memory upload, still counted until it's done.
			directConversationRef.current = meta.conversationId;
			void uploadDirectly({
				chunk,
				conversationId: meta.conversationId,
				runFinishHook: false,
				source: meta.source,
				timestamp: meta.timestamp,
			})
				.then(() => {
					const { directSent } = counts.current;
					directSent[meta.conversationId] =
						(directSent[meta.conversationId] ?? 0) + 1;
				})
				.catch(() => {}) // the mutation reports its own failure
				.finally(() => {
					hold(meta.conversationId, -1);
					countsChanged();
				});
		},
		[uploadDirectly, countsChanged, hold, handedToStore],
	);

	const openChunkSink = useCallback(
		(meta: ChunkMeta): ChunkSink => ({
			begin: (mimeType) => {
				const { conversationId, source } = meta;
				const groupId = crypto.randomUUID();
				const timestamp = new Date();
				// The same slices in memory, sent the old way if the store fails.
				const slices: Blob[] = [];
				const lock = holdRecordingLock(groupId);
				const release = () => {
					lock.release();
					recordingLocks.current.delete(release);
				};
				recordingLocks.current.add(release);
				// Whether every write so far landed. Writes go in order, the first
				// once the lock keeps drainers off the group. After a failed write
				// the rest are skipped: a chunk with a hole in it won't play.
				let written = lock.held.then(() => true);

				return {
					append: (slice) => {
						const index = slices.push(slice) - 1;
						written = written.then(async (ok) => {
							const store = ok && (await storeRef.current);
							if (!store) return false;
							try {
								await store.appendSlice({
									audio: await slice.arrayBuffer(),
									conversationId,
									groupId,
									index,
									mimeType,
									source,
									startedAt: timestamp.toISOString(),
								});
								return true;
							} catch (error) {
								posthog.capture("portal_outbox_store_failed", {
									error: errorMessage(error),
									stage: "append",
								});
								return false;
							}
						});
					},

					discard: async () => {
						await written;
						await (await storeRef.current)
							?.discardGroup(groupId)
							.catch(() => {});
						release();
					},

					seal: async () => {
						hold(conversationId, 1);
						countsChanged();
						try {
							const store = (await written) && (await storeRef.current);
							if (store) {
								try {
									const item = await store.sealGroup(groupId);
									if (item) {
										await handedToStore(conversationId, item.audio.byteLength);
										return;
									}
								} catch (error) {
									posthog.capture("portal_outbox_store_failed", {
										error: errorMessage(error),
										stage: "seal",
									});
								}
							}
							// Drop the partial slices while the lock still keeps drainers
							// off them, then send the copy in memory the old way.
							await (await storeRef.current)
								?.discardGroup(groupId)
								.catch(() => {});
							const sent = enqueueChunk(new Blob(slices, { type: mimeType }), {
								conversationId,
								source,
								timestamp,
							});
							hold(conversationId, -1);
							countsChanged();
							await sent;
						} finally {
							release();
						}
					},
				};
			},
		}),
		[countsChanged, enqueueChunk, handedToStore, hold],
	);

	const settled = useCallback(
		async (conversationId: string) => {
			await refreshRef.current();
			if (queued(conversationId) === 0) return;
			await new Promise<void>((done) => {
				waiters.current.add({ conversationId, done });
			});
		},
		[queued],
	);

	const progress = useCallback(
		(conversationId: string): OutboxProgress => {
			const { directSent, inMemory, seen } = counts.current;
			const waiting = queued(conversationId);
			const total =
				(seen[conversationId]?.size ?? 0) +
				(inMemory[conversationId] ?? 0) +
				(directSent[conversationId] ?? 0);
			return { queued: waiting, sent: total - waiting, total };
		},
		[queued],
	);

	const onRecordingNotice = useCallback(
		(conversationId: string, listener: (notice: RecordingNotice) => void) => {
			const entry = { conversationId, listener };
			noticeListeners.current.add(entry);
			return () => {
				noticeListeners.current.delete(entry);
			};
		},
		[],
	);

	// A new value per version, so readers of queuedCount re-render.
	// biome-ignore lint/correctness/useExhaustiveDependencies: version is the point
	const value = useMemo<Outbox>(
		() => ({
			onRecordingNotice,
			openChunkSink,
			progress,
			queuedCount: queued,
			settled,
		}),
		[onRecordingNotice, openChunkSink, progress, queued, settled, version],
	);

	return (
		<OutboxContext.Provider value={value}>{children}</OutboxContext.Provider>
	);
};
