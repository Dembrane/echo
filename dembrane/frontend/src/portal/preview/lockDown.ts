import posthog from "posthog-js";

/**
 * Takes away everything in this document that could reach the world (ECHO-1060), before a
 * preview screen mounts: the preview shows participant screens with a host's unsaved
 * values, so it must never create a conversation, write anything, ask for the microphone
 * or count as a visit. It runs only inside the dashboard's preview frame, which is its own
 * document, so nothing here touches a participant's portal.
 *
 * Requests fail at once (fetch, XMLHttpRequest, beacons, sockets, event streams), the
 * microphone, camera and screen are refused, and analytics capture nothing. The screens are
 * also inert, and their data is seeded, so a request is never needed; this is the floor
 * under that.
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

	// Not opt_out_capturing: that is stored for the portal's origin and would follow the
	// host into a real portal later. Capturing nothing in this document is enough.
	try {
		posthog.capture = (() => undefined) as typeof posthog.capture;
		posthog.register = (() => undefined) as typeof posthog.register;
	} catch {
		// Analytics not loaded in this build.
	}
}
