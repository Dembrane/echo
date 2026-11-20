import axios from "axios";
import type { ChunkItem, OutboxStore, Parked, SliceGroup } from "./outboxStore";

const FIRST_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** How often a tab left open tries a parked chunk again. Each new visit also tries once. */
const PARKED_RETRY_MS = 60 * 60 * 1000;

/**
 * A recording cut off under this holds no audio worth sending: an MP4's first
 * slice is only its ~600-byte header. Matches the recorder's own floor.
 */
const MIN_RECOVERED_BYTES = 1024;

/** The server says the conversation is gone or closed to us: sending again won't help. */
const GONE_STATUSES = [403, 404, 410];
/**
 * A recording limit refused the audio. Asking again soon only repeats the
 * refusal, but the limit can lift (a new month, an upgrade), so it's parked.
 */
const LIMIT_STATUS = 402;

type Uploaded = NonNullable<ChunkItem["uploaded"]>;

export type OutboxApi = {
	/** Gets a presigned URL and puts the audio in S3. */
	upload: (item: ChunkItem) => Promise<Uploaded>;
	confirm: (item: ChunkItem, uploaded: Uploaded) => Promise<unknown>;
};

export type OutboxEvent =
	| {
			type: "delivered";
			item: ChunkItem;
			ageMs: number;
			attempts: number;
			/** What the server answered the confirm with. */
			response: unknown;
	  }
	| { type: "dropped"; item: ChunkItem; reason: string; error?: unknown }
	| {
			type: "parked";
			item: ChunkItem;
			error: unknown;
			/** It was parked already: a retry that was refused again. */
			again: boolean;
	  }
	| {
			type: "retrying";
			item: ChunkItem;
			attempts: number;
			retryInMs: number;
			error: unknown;
	  }
	| { type: "recovered"; group: SliceGroup; item: ChunkItem }
	| { type: "discarded"; group: SliceGroup; reason: "empty" | "expired" };

export type Drainer = {
	/**
	 * Housekeeping before the first drain: seals recordings a dead tab left
	 * mid-chunk, and drops items too old to send.
	 */
	start: () => Promise<void>;
	/**
	 * Sends everything it can. Resolves with how long until the next item is
	 * due a retry, or null once the outbox is empty.
	 */
	drain: () => Promise<number | null>;
	/** Forgets every backoff, e.g. on coming back online, so the next drain tries all. */
	retryNow: () => void;
};

const httpStatus = (error: unknown) =>
	axios.isAxiosError(error) ? error.response?.status : undefined;

/** Held by a tab for as long as it records into a slice group. */
export const recordingLockName = (groupId: string) => `recording:${groupId}`;

const heldWebLocks = async () => {
	if (!navigator.locks?.query) return null;
	const { held = [] } = await navigator.locks.query();
	return new Set(held.flatMap((lock) => (lock.name ? [lock.name] : [])));
};

/**
 * Sends the outbox one chunk at a time. Order is kept within a conversation,
 * and each conversation backs off on its own, so one that keeps failing never
 * holds up another's audio. A chunk a recording limit refused is parked and
 * stepped over until it's due again, so it never blocks the queue.
 */
export const createDrainer = ({
	store,
	api,
	now = Date.now,
	onEvent = () => {},
	heldLocks = heldWebLocks,
}: {
	store: OutboxStore;
	api: OutboxApi;
	now?: () => number;
	onEvent?: (event: OutboxEvent) => void;
	/** Names of the Web Locks held in any tab, or null if the browser can't say. */
	heldLocks?: () => Promise<Set<string> | null>;
}): Drainer => {
	// In memory only: after a reload, everything is tried straight away.
	const backoff = new Map<string, { failures: number; retryAt: number }>();
	// A chunk parked before this drainer existed gets one try on this visit.
	const startedAt = now();
	const parkedDue = (parked: Parked) =>
		parked.retryAt <= now() || parked.at < startedAt;

	const fail = (item: ChunkItem, attempts: number, error: unknown) => {
		const failures = (backoff.get(item.conversationId)?.failures ?? 0) + 1;
		const retryInMs = Math.min(
			FIRST_BACKOFF_MS * 2 ** (failures - 1),
			MAX_BACKOFF_MS,
		);
		backoff.set(item.conversationId, { failures, retryAt: now() + retryInMs });
		onEvent({ attempts, error, item, retryInMs, type: "retrying" });
	};

	const send = async (item: ChunkItem) => {
		const attempts = item.attempts + 1;
		await store.noteAttempt(item.seq);
		let uploaded = item.uploaded;
		let response: unknown;
		try {
			if (!uploaded) {
				uploaded = await api.upload(item);
				await store.markUploaded(item.seq, uploaded);
			}
			response = await api.confirm(item, uploaded);
		} catch (error) {
			const status = httpStatus(error);
			if (status === LIMIT_STATUS) {
				const at = now();
				await store.park(item.seq, {
					at,
					reason: `http_${status}`,
					retryAt: at + PARKED_RETRY_MS,
				});
				backoff.delete(item.conversationId);
				onEvent({ again: !!item.parked, error, item, type: "parked" });
				return;
			}
			if (status && GONE_STATUSES.includes(status)) {
				await store.remove(item.seq);
				backoff.delete(item.conversationId);
				onEvent({ error, item, reason: `http_${status}`, type: "dropped" });
				return;
			}
			// Confirm answers 400 when S3 doesn't have the file: upload it again.
			if (uploaded && status === 400) {
				await store.markUploaded(item.seq, undefined);
			}
			fail(item, attempts, error);
			return;
		}
		await store.remove(item.seq);
		backoff.delete(item.conversationId);
		onEvent({
			ageMs: now() - item.createdAt,
			attempts,
			item,
			response,
			type: "delivered",
		});
	};

	/**
	 * The oldest item of each conversation that isn't backing off, oldest
	 * first. A parked chunk that isn't due is stepped over, so it never holds
	 * up the audio behind it.
	 */
	const pass = async (): Promise<number | null> => {
		while (true) {
			const items = await store.list();
			if (items.length === 0) return null;

			const heads = new Map<string, ChunkItem>();
			let soonest = Number.POSITIVE_INFINITY;
			for (const item of items) {
				if (heads.has(item.conversationId)) continue;
				if (item.parked && !parkedDue(item.parked)) {
					soonest = Math.min(soonest, item.parked.retryAt);
					continue;
				}
				heads.set(item.conversationId, item);
			}
			const due = [...heads.values()].find(
				(item) => (backoff.get(item.conversationId)?.retryAt ?? 0) <= now(),
			);
			if (!due) {
				for (const id of heads.keys())
					soonest = Math.min(soonest, backoff.get(id)?.retryAt ?? 0);
				return soonest - now();
			}
			await send(due);
		}
	};

	// A wake-up during a pass doesn't start a second one, but does make the
	// running one look again before it settles.
	let running: Promise<number | null> | null = null;
	let wokenWhileRunning = false;

	const drain = () => {
		if (running) {
			wokenWhileRunning = true;
			return running;
		}
		running = (async () => {
			try {
				let wait: number | null;
				do {
					wokenWhileRunning = false;
					wait = await pass();
				} while (wokenWhileRunning);
				return wait;
			} finally {
				running = null;
			}
		})();
		return running;
	};

	/** Seals the slice groups of recordings that died mid-chunk, so they get sent. */
	const recoverOrphans = async () => {
		const held = await heldLocks();
		// Without the lock list, a live recording looks the same as a dead one.
		if (!held) return;
		for (const group of await store.listSliceGroups()) {
			if (held.has(recordingLockName(group.groupId))) continue;
			const reason =
				Date.parse(group.startedAt) < now() - MAX_AGE_MS
					? "expired"
					: group.bytes < MIN_RECOVERED_BYTES
						? "empty"
						: null;
			if (reason) {
				await store.discardGroup(group.groupId);
				onEvent({ group, reason, type: "discarded" });
				continue;
			}
			const item = await store.sealGroup(group.groupId, { recovered: true });
			if (item) onEvent({ group, item, type: "recovered" });
		}
	};

	const start = async () => {
		await recoverOrphans();
		const expired = await store.purgeOlderThan(now() - MAX_AGE_MS);
		for (const item of expired)
			onEvent({ item, reason: "expired", type: "dropped" });
	};

	return { drain, retryNow: () => backoff.clear(), start };
};
