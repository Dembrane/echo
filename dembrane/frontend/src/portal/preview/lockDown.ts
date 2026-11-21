import posthog from "posthog-js";

/**
 * Takes away everything in this document that could reach the world (ECHO-1060), before a
 * preview screen mounts: the preview shows participant screens with a host's unsaved
 * values, so it must never create a conversation, write anything, ask for the microphone
 * or count as a visit. It runs only inside the dashboard's preview frame, which is its own
 * document, so nothing here touches a participant's portal.
 *
 * Requests fail at once (fetch, XMLHttpRequest, beacons, sockets, event streams), the
 * microphone, camera and screen are refused, and analytics capture nothing. The host can
 * click through the screens (ECHO-1062), so a form never submits and a plain link never
 * leaves (the screens' own buttons and router links still work), and what the screens
 * store (a cooldown, a preference) stays in this page's memory. The screens' data is
 * seeded and their requests answered from it (fixtures.ts); this is the floor under that.
 */
export function lockDown(win: Window & typeof globalThis = window): void {
	const refused = () => new TypeError("The portal preview sends nothing.");

	win.fetch = (() => Promise.reject(refused())) as typeof fetch;

	class NoRequest {
		constructor() {
			throw refused();
		}
	}
	const blocked = NoRequest as unknown;
	win.XMLHttpRequest = blocked as typeof XMLHttpRequest;
	win.WebSocket = blocked as typeof WebSocket;
	win.EventSource = blocked as typeof EventSource;

	const nav = win.navigator as Navigator & {
		sendBeacon?: Navigator["sendBeacon"];
	};
	try {
		Object.defineProperty(nav, "sendBeacon", {
			configurable: true,
			value: () => false,
		});
	} catch {
		// Not writable here: the request blocks above still hold.
	}

	const media = nav.mediaDevices;
	if (media) {
		const deny = () =>
			Promise.reject(
				new DOMException(
					"The portal preview asks for no devices.",
					"NotAllowedError",
				),
			);
		for (const name of ["getUserMedia", "getDisplayMedia"] as const) {
			try {
				Object.defineProperty(media, name, { configurable: true, value: deny });
			} catch {
				// The frame's permissions policy refuses the devices as well.
			}
		}
	}

	// A form's submission and a plain link's navigation are cancelled after the page's own
	// handlers ran (the submit listener first, so nothing outruns it; the click listener
	// last, so a router link has already done its work).
	win.addEventListener?.("submit", (e) => e.preventDefault(), true);
	win.addEventListener?.("click", (e) => {
		const target = e.target as Element | null;
		if (target?.closest?.("a[href]")) e.preventDefault();
	});
	if (win.HTMLFormElement)
		win.HTMLFormElement.prototype.submit = () => undefined;

	for (const name of ["localStorage", "sessionStorage"] as const) {
		try {
			Object.defineProperty(win, name, {
				configurable: true,
				value: memoryStorage(win[name]),
			});
		} catch {
			// Storage unreachable here: then there is nothing to write to either.
		}
	}

	// Not opt_out_capturing: that is stored for the portal's origin and would follow the
	// host into a real portal later. Capturing nothing in this document is enough.
	try {
		posthog.capture = (() => undefined) as typeof posthog.capture;
		posthog.register = (() => undefined) as typeof posthog.register;
	} catch {
		// Analytics not loaded in this build.
	}
}

/** A Storage that starts as a copy of `from` and keeps every write in memory. */
export function memoryStorage(from: Storage | undefined): Storage {
	const items = new Map<string, string>();
	try {
		for (let i = 0; from && i < from.length; i++) {
			const key = from.key(i);
			if (key !== null) items.set(key, from.getItem(key) ?? "");
		}
	} catch {
		// Not readable: start empty.
	}
	return {
		clear: () => items.clear(),
		getItem: (key) => items.get(String(key)) ?? null,
		key: (index) => [...items.keys()][index] ?? null,
		get length() {
			return items.size;
		},
		removeItem: (key) => {
			items.delete(String(key));
		},
		setItem: (key, value) => {
			items.set(String(key), String(value));
		},
	};
}
