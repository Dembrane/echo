/**
 * Pilot hard-block signal bus.
 *
 * Matrix §8 ships a 402 with a copy-locked body when a Pilot workspace
 * tries a host-side operation past its 10h cap. We detect that exact
 * response server-side and surface a level-3 modal via this bus.
 *
 * Why a custom event instead of a context? Host-side operations fan out
 * across many mutation sites (chat, agentic, report, project create,
 * export). A context would require every caller to thread a trigger fn.
 * A single window event is trigger-from-anywhere, listen-anywhere.
 */

import { useEffect, useState } from "react";

export interface PilotBlockDetail {
	message: string;
	workspaceId?: string | null;
}

const EVENT_NAME = "dembrane:pilot-block";

// Shape of the 402 body the backend emits. Stable per matrix §8.
const MATRIX_COPY_MARKER = "Pilot limit reached";

export function emitPilotBlock(detail: PilotBlockDetail) {
	window.dispatchEvent(new CustomEvent<PilotBlockDetail>(EVENT_NAME, { detail }));
}

export function onPilotBlock(handler: (detail: PilotBlockDetail) => void) {
	const listener = (e: Event) => {
		const ce = e as CustomEvent<PilotBlockDetail>;
		handler(ce.detail);
	};
	window.addEventListener(EVENT_NAME, listener);
	return () => window.removeEventListener(EVENT_NAME, listener);
}

/**
 * Inspect an Error thrown by our fetch wrappers. If the message matches
 * the matrix §8 Pilot-block copy, fire the event.
 *
 * Wire this in the React Query default error handlers so we catch blocks
 * at the mutation level without threading code through every caller.
 */
export function detectAndEmitPilotBlock(
	error: unknown,
	context?: { workspaceId?: string | null },
): boolean {
	if (!(error instanceof Error)) return false;
	if (!error.message.includes(MATRIX_COPY_MARKER)) return false;
	emitPilotBlock({
		message: error.message,
		workspaceId: context?.workspaceId ?? null,
	});
	return true;
}

/**
 * Subscribe to Pilot-block events from a React component. Returns the
 * latest detail (or null if none) and a clear() function. Used by the
 * PilotBlockModal.
 */
export function usePilotBlockSignal() {
	const [detail, setDetail] = useState<PilotBlockDetail | null>(null);
	useEffect(() => onPilotBlock(setDetail), []);
	return {
		detail,
		clear: () => setDetail(null),
	};
}
