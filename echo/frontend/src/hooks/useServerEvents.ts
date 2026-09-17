import { useEffect, useRef } from "react";

export type ServerEvent = { type: string } & Record<string, unknown>;

const MAX_RETRY_MS = 15000;

/**
 * Follows a server-sent events stream for as long as the caller is mounted.
 *
 * The server opens every stream with a `connected` event, including after a
 * reconnect. Events published while the stream was down are not replayed, so
 * reload whatever you show when `connected` arrives. `types` lists the event
 * names to deliver besides `connected`. Pass `null` as the url to stay idle.
 */
export function useServerEvents(
	url: string | null,
	types: readonly string[],
	onEvent: (event: ServerEvent) => void,
) {
	const handlerRef = useRef(onEvent);
	useEffect(() => {
		handlerRef.current = onEvent;
	}, [onEvent]);

	const typesKey = types.join("|");

	useEffect(() => {
		if (!url) return;
		const names = typesKey ? typesKey.split("|") : [];
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
				data && typeof data === "object"
					? (data as Record<string, unknown>)
					: {};
			handlerRef.current({ ...fields, type: message.type });
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
	}, [url, typesKey]);
}
