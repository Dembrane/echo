import { useEffect, useRef } from "react";

export type ServerEvent = { type: string } & Record<string, unknown>;

const MAX_RETRY_MS = 15000;

/**
 * Opens `url` as an event stream and hands each named event, `connected` and
 * every drop (`disconnected`) to `emit`, reconnecting with backoff until the
 * returned function closes it.
 */
function follow(
	url: string,
	names: readonly string[],
	emit: (event: ServerEvent) => void,
): () => void {
	let source: EventSource | null = null;
	let closed = false;
	let reconnectTimer: number | null = null;
	let retryMs = 1000;

	const deliver = (message: MessageEvent) => {
		let data: unknown = null;
		try {
			data = message.data ? JSON.parse(message.data) : null;
		} catch {
			data = null;
		}
		const fields =
			data && typeof data === "object" ? (data as Record<string, unknown>) : {};
		emit({ ...fields, type: message.type });
	};

	const connect = () => {
		if (closed) return;
		source = new EventSource(url, { withCredentials: true });
		source.addEventListener("connected", (message) => {
			retryMs = 1000;
			deliver(message as MessageEvent);
		});
		for (const name of names) {
			source.addEventListener(name, (message) =>
				deliver(message as MessageEvent),
			);
		}
		source.onerror = () => {
			source?.close();
			source = null;
			if (closed) return;
			emit({ type: "disconnected" });
			reconnectTimer = window.setTimeout(connect, retryMs);
			retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
		};
	};

	connect();
	return () => {
		closed = true;
		if (reconnectTimer) window.clearTimeout(reconnectTimer);
		source?.close();
	};
}

const canShare = () =>
	typeof BroadcastChannel !== "undefined" &&
	typeof navigator !== "undefined" &&
	!!navigator.locks;

/**
 * Follows a server-sent events stream for as long as the caller is mounted.
 *
 * The server opens every stream with a `connected` event, including after a
 * reconnect. Events published while the stream was down are not replayed, so
 * reload whatever you show when `connected` arrives. `types` lists the event
 * names to deliver besides `connected`. Pass `null` as the url to stay idle.
 *
 * A stream the server ends (access withdrawn) looks like any other drop here:
 * the hook keeps reconnecting and the browser never says why. List
 * `disconnected` in `types` to hear about each drop and check for yourself.
 *
 * With `shared`, every window of this browser following the same stream
 * shares one connection: one holds it and passes each event on to the others,
 * and when it closes the next one takes it over. A browser allows a site only
 * a few open connections, so each room screen holding its own would leave the
 * next screen unable to load.
 */
export function useServerEvents(
	url: string | null,
	types: readonly string[],
	onEvent: (event: ServerEvent) => void,
	{ shared = false }: { shared?: boolean } = {},
) {
	const handlerRef = useRef(onEvent);
	useEffect(() => {
		handlerRef.current = onEvent;
	}, [onEvent]);

	const typesKey = types.join("|");

	useEffect(() => {
		if (!url) return;
		const listed = typesKey ? typesKey.split("|") : [];
		const names = listed.filter((name) => name !== "disconnected");
		const wanted = (event: ServerEvent) =>
			event.type !== "disconnected" || listed.includes("disconnected");
		const tell = (event: ServerEvent) => {
			if (wanted(event)) handlerRef.current(event);
		};
		if (!shared || !canShare()) return follow(url, names, tell);

		// Keyed by the server's event names too, so a window that listens for
		// fewer of them never holds the stream for one that wants more.
		const key = `dembrane-events:${url}#${names.join("|")}`;
		const channel = new BroadcastChannel(key);
		channel.onmessage = (message: MessageEvent<ServerEvent>) => {
			if (message.data?.type) tell(message.data);
		};
		const leaving = new AbortController();
		let release: (() => void) | null = null;
		navigator.locks
			.request(
				key,
				{ signal: leaving.signal },
				() =>
					new Promise<void>((done) => {
						if (leaving.signal.aborted) return done();
						const close = follow(url, names, (event) => {
							channel.postMessage(event);
							tell(event);
						});
						release = () => {
							close();
							done();
						};
					}),
			)
			// Leaving before this window's turn came.
			.catch(() => {});
		return () => {
			leaving.abort();
			release?.();
			channel.close();
		};
	}, [url, typesKey, shared]);
}
