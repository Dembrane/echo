import { useEffect, useState } from "react";

// The room's screen and the Present page talk over one channel in this
// browser: a screen says it is open, the page listens. The server does not
// know when a screen is open, so a screen on another computer is not heard.
const CHANNEL = "dembrane-present-room";
const BEAT_MS = 5_000;
// A hidden window's timers can slow to once a minute; only a screen silent for
// longer than that counts as gone without saying so.
const STALE_MS = 90_000;

type RoomMessage = {
	presentationId: string;
	screen?: string;
	kind: "here" | "gone" | "who";
};

const openChannel = () =>
	typeof BroadcastChannel === "undefined"
		? null
		: new BroadcastChannel(CHANNEL);

/** Said by the room's screen while it is open. */
export function useAnnounceRoomScreen(presentationId?: string) {
	useEffect(() => {
		if (!presentationId) return;
		const channel = openChannel();
		if (!channel) return;
		const screen = Math.random().toString(36).slice(2);
		const say = (kind: RoomMessage["kind"]) =>
			channel.postMessage({ kind, presentationId, screen } as RoomMessage);
		channel.onmessage = (event: MessageEvent<RoomMessage>) => {
			if (
				event.data?.kind === "who" &&
				event.data.presentationId === presentationId
			)
				say("here");
		};
		say("here");
		const beat = setInterval(() => say("here"), BEAT_MS);
		const leave = () => say("gone");
		window.addEventListener("pagehide", leave);
		return () => {
			clearInterval(beat);
			window.removeEventListener("pagehide", leave);
			leave();
			channel.close();
		};
	}, [presentationId]);
}

/** Whether a room screen for this presentation is open in this browser. */
export function useRoomScreenOpen(presentationId: string) {
	const [open, setOpen] = useState(false);
	useEffect(() => {
		const channel = openChannel();
		if (!channel) return;
		const screens = new Map<string, number>();
		const update = () => {
			const now = Date.now();
			for (const [screen, seen] of screens)
				if (now - seen > STALE_MS) screens.delete(screen);
			setOpen(screens.size > 0);
		};
		channel.onmessage = (event: MessageEvent<RoomMessage>) => {
			const { kind, presentationId: id, screen } = event.data ?? {};
			if (id !== presentationId || !screen) return;
			if (kind === "here") screens.set(screen, Date.now());
			if (kind === "gone") screens.delete(screen);
			update();
		};
		channel.postMessage({ kind: "who", presentationId } as RoomMessage);
		const sweep = setInterval(update, BEAT_MS);
		return () => {
			clearInterval(sweep);
			channel.close();
		};
	}, [presentationId]);
	return open;
}
