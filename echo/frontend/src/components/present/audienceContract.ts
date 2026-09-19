import { API_BASE_URL } from "@/config";

export type DeckBlock = "popcorn" | "stakeholders" | "tensions";

export type DeckCommand =
	| {
			command: "refresh" | "dismiss-opening";
			presentationId: string;
			source: "dembrane-present-shell";
			version: 1;
	  }
	| {
			block: DeckBlock;
			command: "block";
			presentationId: string;
			source: "dembrane-present-shell";
			version: 1;
	  }
	| {
			command: "visibility";
			presentationId: string;
			source: "dembrane-present-shell";
			version: 1;
			visible: boolean;
	  }
	| {
			command: "opening";
			presentationId: string;
			screen: "intro" | "data";
			source: "dembrane-present-shell";
			version: 1;
	  }
	| {
			command: "theme";
			presentationId: string;
			source: "dembrane-present-shell";
			theme: "light" | "dark";
			version: 1;
	  };

export type DeckReadyMessage = {
	presentationId: string;
	revision?: number;
	source: "dembrane-present-deck";
	type: "ready";
	version: 1;
};

export type DeckOpeningMessage = {
	/** The deck refuses `dismiss-opening` until its own Continue flow is done. */
	locked?: boolean;
	open: boolean;
	presentationId: string;
	screen?: "intro" | "data";
	source: "dembrane-present-deck";
	type: "opening";
	version: 1;
};

export type DeckChromeMessage = {
	live: boolean;
	madeWith: string;
	presentationId: string;
	progress: string;
	qrFold: string;
	qrLabel: string;
	qrShow: string;
	source: "dembrane-present-deck";
	type: "chrome";
	version: 1;
};

export const AUDIENCE_EVENT_REFRESH_MS = 650;
export const AUDIENCE_SAFETY_REFRESH_MS = 60_000;
export const AUDIENCE_READ_TIMEOUT_MS = 15_000;
export const AUDIENCE_RETRY_MIN_MS = 2_000;
export const AUDIENCE_RETRY_MAX_MS = 30_000;
// The link was switched off or access was withdrawn: clear the room's screen.
export const AUDIENCE_GONE_STATUSES: ReadonlySet<number> = new Set([
	401, 403, 404, 410,
]);

export const audienceUrls = ({
	presentationId,
	publicToken,
	draft = false,
}: {
	presentationId?: string;
	publicToken?: string;
	draft?: boolean;
}) => {
	const isPublic = Boolean(publicToken);
	const identity = publicToken ?? presentationId;
	if (!identity) return null;
	const encodedIdentity = encodeURIComponent(identity);
	const base = isPublic
		? `${API_BASE_URL}/v2/popcorn/public/${encodedIdentity}`
		: `${API_BASE_URL}/v2/bff/present/${encodedIdentity}${draft ? "/draft" : ""}`;
	return {
		audience: `${base}/audience`,
		deck: isPublic ? `${base}/` : `${base}/deck/`,
		events: isPublic ? `${base}/events` : `${base}/deck/events`,
		map: `${base}/map`,
	};
};

export const deckVisibilityCommand = (
	presentationId: string,
	visible: boolean,
): DeckCommand => ({
	command: "visibility",
	presentationId,
	source: "dembrane-present-shell",
	version: 1,
	visible,
});

export const deckBlockCommand = (
	presentationId: string,
	block: DeckBlock,
): DeckCommand => ({
	block,
	command: "block",
	presentationId,
	source: "dembrane-present-shell",
	version: 1,
});

export const deckOpeningCommand = (
	presentationId: string,
	screen: "intro" | "data",
): DeckCommand => ({
	command: "opening",
	presentationId,
	screen,
	source: "dembrane-present-shell",
	version: 1,
});

export const deckThemeCommand = (
	presentationId: string,
	theme: "light" | "dark",
): DeckCommand => ({
	command: "theme",
	presentationId,
	source: "dembrane-present-shell",
	theme,
	version: 1,
});

export const postDeckMessage = (
	target: Pick<Window, "postMessage"> | null,
	targetOrigin: string,
	message: DeckCommand,
) => {
	target?.postMessage(message, targetOrigin);
};

export const isDeckReadyEvent = (
	event: Pick<MessageEvent, "data" | "origin" | "source">,
	expected: {
		origin: string;
		presentationId: string;
		source: MessageEventSource | null;
	},
): event is Pick<
	MessageEvent<DeckReadyMessage>,
	"data" | "origin" | "source"
> => {
	if (event.origin !== expected.origin || event.source !== expected.source) {
		return false;
	}
	if (!event.data || typeof event.data !== "object") return false;
	const message = event.data as Partial<DeckReadyMessage>;
	return (
		message.source === "dembrane-present-deck" &&
		message.version === 1 &&
		message.type === "ready" &&
		message.presentationId === expected.presentationId
	);
};

export const isDeckOpeningEvent = (
	event: Pick<MessageEvent, "data" | "origin" | "source">,
	expected: {
		origin: string;
		presentationId: string;
		source: MessageEventSource | null;
	},
): event is Pick<
	MessageEvent<DeckOpeningMessage>,
	"data" | "origin" | "source"
> => {
	if (event.origin !== expected.origin || event.source !== expected.source) {
		return false;
	}
	if (!event.data || typeof event.data !== "object") return false;
	const message = event.data as Partial<DeckOpeningMessage>;
	return (
		message.source === "dembrane-present-deck" &&
		message.version === 1 &&
		message.type === "opening" &&
		message.presentationId === expected.presentationId &&
		typeof message.open === "boolean" &&
		(message.locked === undefined || typeof message.locked === "boolean") &&
		(message.screen === undefined ||
			message.screen === "intro" ||
			message.screen === "data")
	);
};

export const isDeckChromeEvent = (
	event: Pick<MessageEvent, "data" | "origin" | "source">,
	expected: {
		origin: string;
		presentationId: string;
		source: MessageEventSource | null;
	},
): boolean => {
	if (event.origin !== expected.origin || event.source !== expected.source) {
		return false;
	}
	if (!event.data || typeof event.data !== "object") return false;
	const message = event.data as Partial<DeckChromeMessage>;
	return (
		message.source === "dembrane-present-deck" &&
		message.version === 1 &&
		message.type === "chrome" &&
		message.presentationId === expected.presentationId &&
		typeof message.live === "boolean" &&
		typeof message.progress === "string" &&
		typeof message.madeWith === "string" &&
		typeof message.qrFold === "string" &&
		typeof message.qrLabel === "string" &&
		typeof message.qrShow === "string"
	);
};
