import axios from "axios";
import type {
	ChunkItem,
	OutboxItem,
	OutboxStore,
	SliceGroup,
} from "./outboxStore";

const FIRST_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A recording cut off under this holds no audio worth sending: an MP4's first
 * slice is only its ~600-byte header. Matches the recorder's own floor.
 */
const MIN_RECOVERED_BYTES = 1024;

/** The server says the conversation is gone or closed to us: sending again won't help. */
const GONE_STATUSES = [403, 404, 410];

type Uploaded = NonNullable<ChunkItem["uploaded"]>;

export type OutboxApi = {
	/** Gets a presigned URL and puts the audio in S3. */
	upload: (item: ChunkItem) => Promise<Uploaded>;
	confirm: (item: ChunkItem, uploaded: Uploaded) => Promise<unknown>;
	finish: (conversationId: string) => Promise<unknown>;
};

export type OutboxEvent =
	| { type: "delivered"; item: OutboxItem; ageMs: number; attempts: number }
	| { type: "dropped"; item: OutboxItem; reason: string }
	| {
			type: "retrying";
			item: OutboxItem;
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
 * Sends the outbox one item at a time. Order is kept within a conversation
 * (its chunks, then its finish), and each conversation backs off on its own,
 * so one that keeps failing never holds up another's audio. A finish needs no
 * special gate: it's only picked once it's its conversation's oldest item.
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

	const fail = (item: OutboxItem, attempts: number, error: unknown) => {
		const failures = (backoff.get(item.conversationId)?.failures ?? 0) + 1;
		const retryInMs = Math.min(
			FIRST_BACKOFF_MS * 2 ** (failures - 1),
			MAX_BACKOFF_MS,
		);
		backoff.set(item.conversationId, { failures, retryAt: now() + retryInMs });
		onEvent({ attempts, error, item, retryInMs, type: "retrying" });
	};

	const send = async (item: OutboxItem) => {
		const attempts = item.attempts + 1;
		await store.noteAttempt(item.seq);
		let uploaded = item.kind === "chunk" ? item.uploaded : undefined;
		try {
			if (item.kind === "finish") {
				await api.finish(item.conversationId);
			} else {
				if (!uploaded) {
					uploaded = await api.upload(item);
					await store.markUploaded(item.seq, uploaded);
				}
				await api.confirm(item, uploaded);
			}
		} catch (error) {
			const status = httpStatus(error);
			if (status && GONE_STATUSES.includes(status)) {
				await store.remove(item.seq);
				backoff.delete(item.conversationId);
				onEvent({ item, reason: `http_${status}`, type: "dropped" });
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
			type: "delivered",
		});
	};

	/** The oldest item of each conversation that isn't backing off, oldest first. */
	const pass = async (): Promise<number | null> => {
		while (true) {
			const items = await store.list();
			if (items.length === 0) return null;

			const heads = new Map<string, OutboxItem>();
			for (const item of items) {
				if (!heads.has(item.conversationId))
					heads.set(item.conversationId, item);
			}
			const due = [...heads.values()].find(
				(item) => (backoff.get(item.conversationId)?.retryAt ?? 0) <= now(),
			);
			if (!due) {
				const soonest = Math.min(
					...[...heads.keys()].map((id) => backoff.get(id)?.retryAt ?? 0),
				);
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

	return { drain, start };
};
