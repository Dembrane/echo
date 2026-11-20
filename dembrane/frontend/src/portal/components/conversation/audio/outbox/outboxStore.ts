/**
 * The participant's audio, kept in IndexedDB until the server has it, so a
 * dropped network, a reload or a crash loses at most the last second.
 *
 * Two stores: `slices` holds the 1s pieces of the chunk being recorded right
 * now; `outbox` holds whole chunks waiting to send, in the order they were
 * recorded. Audio is kept as an ArrayBuffer, not a Blob: older iOS
 * Safari loses Blobs stored in IndexedDB.
 */

const DEFAULT_DB_NAME = "dembrane-portal-outbox";
const DB_VERSION = 1;
const SLICES = "slices";
const OUTBOX = "outbox";

export type Slice = {
	/** One per MediaRecorder instance, so one per future chunk. */
	groupId: string;
	index: number;
	conversationId: string;
	audio: ArrayBuffer;
	mimeType: string;
	/** When the group started recording: the chunk's timestamp. */
	startedAt: string;
	source: string;
};

export type SliceGroup = {
	groupId: string;
	conversationId: string;
	startedAt: string;
	sliceCount: number;
	bytes: number;
};

export type NewChunk = {
	conversationId: string;
	audio: ArrayBuffer;
	mimeType: string;
	/** The recording time, sent on to confirm-upload. */
	timestamp: string;
	source: string;
	recovered?: true;
};

export type ChunkItem = NewChunk & {
	kind: "chunk";
	seq: number;
	createdAt: number;
	attempts: number;
	/** Set once S3 has the file, so a retry only re-confirms. */
	uploaded?: { chunk_id: string; file_url: string };
	/**
	 * Set when a recording limit refused it. Kept, since the limit can lift (a
	 * new month, an upgrade), and tried again later instead of with the queue.
	 */
	parked?: Parked;
};

export type Parked = {
	/** Why the server refused it, e.g. `http_402`. */
	reason: string;
	/** When it was last refused (ms). */
	at: number;
	/** When it is next due a try (ms). */
	retryAt: number;
};

export type OutboxStore = {
	appendSlice: (slice: Slice) => Promise<void>;
	/** Moves a group's slices into one queued chunk, atomically. Null if it has none. */
	sealGroup: (
		groupId: string,
		options?: { recovered?: boolean },
	) => Promise<ChunkItem | null>;
	discardGroup: (groupId: string) => Promise<void>;
	listSliceGroups: () => Promise<SliceGroup[]>;
	enqueueChunk: (chunk: NewChunk) => Promise<ChunkItem>;
	/** Every queued chunk, oldest first. */
	list: () => Promise<ChunkItem[]>;
	markUploaded: (seq: number, uploaded: ChunkItem["uploaded"]) => Promise<void>;
	noteAttempt: (seq: number) => Promise<void>;
	/** Marks a refused chunk to try again later. The server deleted any upload, so that's forgotten. */
	park: (seq: number, parked: Parked) => Promise<void>;
	remove: (seq: number) => Promise<void>;
	/** Removes chunks created before `cutoff` (ms) and returns them. */
	purgeOlderThan: (cutoff: number) => Promise<ChunkItem[]>;
	close: () => void;
};

const request = <T>(req: IDBRequest<T>) =>
	new Promise<T>((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});

const committed = (tx: IDBTransaction) =>
	new Promise<void>((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
	});

// Every [groupId, index] key of one group: arrays sort after numbers.
const groupRange = (groupId: string) =>
	IDBKeyRange.bound([groupId], [groupId, []]);

const concat = (buffers: ArrayBuffer[]) => {
	const out = new Uint8Array(buffers.reduce((n, b) => n + b.byteLength, 0));
	let offset = 0;
	for (const buffer of buffers) {
		out.set(new Uint8Array(buffer), offset);
		offset += buffer.byteLength;
	}
	return out.buffer;
};

const openDb = (name: string) =>
	new Promise<IDBDatabase>((resolve, reject) => {
		const req = indexedDB.open(name, DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			db.createObjectStore(SLICES, { keyPath: ["groupId", "index"] });
			db.createObjectStore(OUTBOX, { autoIncrement: true, keyPath: "seq" });
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});

export const openOutboxStore = async ({
	dbName = DEFAULT_DB_NAME,
	now = Date.now,
}: {
	dbName?: string;
	now?: () => number;
} = {}): Promise<OutboxStore> => {
	const db = await openDb(dbName);

	// Within a transaction, only IDB requests are awaited: awaiting anything
	// else lets the browser commit the transaction early.
	const add = async (
		tx: IDBTransaction,
		item: Omit<ChunkItem, "seq">,
	): Promise<ChunkItem> => {
		const seq = await request(tx.objectStore(OUTBOX).add(item));
		return { ...item, seq } as ChunkItem;
	};

	const update = async (
		seq: number,
		change: (item: ChunkItem) => ChunkItem,
	) => {
		const tx = db.transaction(OUTBOX, "readwrite");
		const store = tx.objectStore(OUTBOX);
		const item = await request<ChunkItem | undefined>(store.get(seq));
		if (item) store.put(change(item));
		await committed(tx);
	};

	return {
		appendSlice: async (slice) => {
			const tx = db.transaction(SLICES, "readwrite");
			tx.objectStore(SLICES).put(slice);
			await committed(tx);
		},

		close: () => db.close(),

		discardGroup: async (groupId) => {
			const tx = db.transaction(SLICES, "readwrite");
			tx.objectStore(SLICES).delete(groupRange(groupId));
			await committed(tx);
		},

		enqueueChunk: async (chunk) => {
			const tx = db.transaction(OUTBOX, "readwrite");
			const item = await add(tx, {
				...chunk,
				attempts: 0,
				createdAt: now(),
				kind: "chunk",
			});
			await committed(tx);
			return item;
		},

		list: async () => {
			const tx = db.transaction(OUTBOX, "readonly");
			return request<ChunkItem[]>(tx.objectStore(OUTBOX).getAll());
		},

		listSliceGroups: async () => {
			const tx = db.transaction(SLICES, "readonly");
			const all = await request<Slice[]>(tx.objectStore(SLICES).getAll());
			const groups = new Map<string, SliceGroup>();
			for (const s of all) {
				const group = groups.get(s.groupId) ?? {
					bytes: 0,
					conversationId: s.conversationId,
					groupId: s.groupId,
					sliceCount: 0,
					startedAt: s.startedAt,
				};
				group.bytes += s.audio.byteLength;
				group.sliceCount += 1;
				groups.set(s.groupId, group);
			}
			return [...groups.values()];
		},

		markUploaded: (seq, uploaded) =>
			update(seq, (item) => ({ ...item, uploaded })),

		noteAttempt: (seq) =>
			update(seq, (item) => ({ ...item, attempts: item.attempts + 1 })),

		park: (seq, parked) =>
			update(seq, (item) => ({ ...item, parked, uploaded: undefined })),

		purgeOlderThan: async (cutoff) => {
			const tx = db.transaction(OUTBOX, "readwrite");
			const store = tx.objectStore(OUTBOX);
			const all = await request<ChunkItem[]>(store.getAll());
			const old = all.filter((item) => item.createdAt < cutoff);
			for (const item of old) store.delete(item.seq);
			await committed(tx);
			return old;
		},

		remove: async (seq) => {
			const tx = db.transaction(OUTBOX, "readwrite");
			tx.objectStore(OUTBOX).delete(seq);
			await committed(tx);
		},

		sealGroup: async (groupId, { recovered } = {}) => {
			const tx = db.transaction([SLICES, OUTBOX], "readwrite");
			const slices = tx.objectStore(SLICES);
			const found = await request<Slice[]>(slices.getAll(groupRange(groupId)));
			if (found.length === 0) {
				await committed(tx);
				return null;
			}
			const [first] = found;
			slices.delete(groupRange(groupId));
			const chunk = await add(tx, {
				attempts: 0,
				audio: concat(found.map((s) => s.audio)),
				conversationId: first.conversationId,
				createdAt: now(),
				kind: "chunk",
				mimeType: first.mimeType,
				source: first.source,
				timestamp: first.startedAt,
				...(recovered && { recovered: true as const }),
			});
			await committed(tx);
			return chunk;
		},
	};
};
