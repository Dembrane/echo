import { useSyncExternalStore } from "react";

/**
 * Which support access requests the consent dialog stays away from, and which one the
 * inbox asked for. Closing a request holds for the browser session (sessionStorage,
 * cleared when someone signs in), as the tasks banner does; the request itself keeps
 * waiting in the inbox and in workspace settings.
 */
export const SUPPORT_REQUEST_SEEN_KEY = "dembrane_support_request_seen";

type State = { seen: readonly string[]; asked: string | null };

function readSeen(): readonly string[] {
	try {
		const raw = sessionStorage.getItem(SUPPORT_REQUEST_SEEN_KEY);
		const parsed: unknown = raw ? JSON.parse(raw) : [];
		return Array.isArray(parsed)
			? parsed.filter((id): id is string => typeof id === "string")
			: [];
	} catch {
		return [];
	}
}

// Kept in memory too, so a browser that refuses storage still remembers for this page.
let state: State = { asked: null, seen: readSeen() };
const listeners = new Set<() => void>();

function set(next: State) {
	state = next;
	for (const listener of listeners) listener();
}

export function requestSeen(id: string): boolean {
	return state.seen.includes(id);
}

/** Closed without an answer: it stays away for the session, and is no longer asked for. */
export function markRequestSeen(id: string): void {
	const seen = state.seen.includes(id) ? state.seen : [...state.seen, id];
	try {
		sessionStorage.setItem(SUPPORT_REQUEST_SEEN_KEY, JSON.stringify(seen));
	} catch {}
	set({ asked: state.asked === id ? null : state.asked, seen });
}

/** A new sign-in sees every waiting request again. */
export function resetSupportRequestSeen(): void {
	try {
		sessionStorage.removeItem(SUPPORT_REQUEST_SEEN_KEY);
	} catch {}
	set({ asked: null, seen: [] });
}

/** Asked for from the inbox: shows this request even when it was closed this session. */
export function openSupportRequest(id: string): void {
	set({ ...state, asked: id });
}

const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};
const snapshot = () => state;

/** Subscribes a component to the two above (useSyncExternalStore). */
export function useSupportRequestPromptState(): State {
	return useSyncExternalStore(subscribe, snapshot, snapshot);
}
