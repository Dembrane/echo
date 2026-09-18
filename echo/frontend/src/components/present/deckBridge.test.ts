import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

// Exercise the vendored receiver itself. Repeated reconnect acknowledgements
// previously rebuilt Popcorn each second, preventing its language transition.
const source = readFileSync(
	new URL("../../../../server/dembrane/popcorn/static/app.js", import.meta.url),
	"utf8",
);
const styles = readFileSync(
	new URL(
		"../../../../server/dembrane/popcorn/static/styles.css",
		import.meta.url,
	),
	"utf8",
);
const receiver = source.slice(
	source.indexOf('  addEventListener("message", (event) => {'),
	source.indexOf("  loadAll().then(() => {"),
);

function bridge() {
	let receive: (event: unknown) => void = () => {};
	const parent = {};
	const state = { active: "popcorn" };
	const showSlide = vi.fn((block: string) => {
		state.active = block;
	});
	const freezeScreen = vi.fn();
	const scheduleEventRefresh = vi.fn();
	runInNewContext(receiver, {
		addEventListener: (_name: string, callback: typeof receive) => {
			receive = callback;
		},
		bundleCache: {},
		EMBED: { parentOrigin: "https://host.example", presentationId: "room" },
		freezeScreen,
		location: { origin: "https://api.example" },
		parent,
		scheduleEventRefresh,
		showSlide,
		state,
		visibleSlides: () =>
			["popcorn", "tensions", "stakeholders"].map((id) => ({ id })),
	});
	const event = (data = {}) => ({
		data: {
			block: "popcorn",
			command: "block",
			presentationId: "room",
			source: "dembrane-present-shell",
			version: 1,
			...data,
		},
		origin: "https://host.example",
		source: parent,
	});
	return { event, freezeScreen, receive, scheduleEventRefresh, showSlide };
}

describe("vendored deck bridge", () => {
	it("refreshes draft data without rebuilding the current stage", () => {
		const { receive, event, showSlide, scheduleEventRefresh } = bridge();
		receive(event({ command: "refresh" }));
		expect(scheduleEventRefresh).toHaveBeenCalledOnce();
		expect(showSlide).not.toHaveBeenCalled();
	});
	it("preserves the current stage on repeated ready/reconnect commands", () => {
		const { receive, event, showSlide } = bridge();
		for (let count = 0; count < 10; count++) receive(event());
		expect(showSlide).not.toHaveBeenCalled();
		receive(event({ block: "tensions" }));
		receive(event({ block: "tensions" }));
		expect(showSlide).toHaveBeenCalledTimes(1);
	});

	it("rejects commands from another window, origin, version or presentation", () => {
		const { receive, event, showSlide } = bridge();
		receive({ ...event({ block: "tensions" }), source: {} });
		receive({
			...event({ block: "tensions" }),
			origin: "https://other.example",
		});
		receive(event({ block: "tensions", presentationId: "other-room" }));
		receive(event({ block: "tensions", version: 2 }));
		expect(showSlide).not.toHaveBeenCalled();
	});
});

describe("vendored deck live ownership", () => {
	const schedulerSource = source.slice(
		source.indexOf("  let eventRefreshTimer = null;"),
		source.indexOf("  /* A standalone deck owns one stream."),
	);
	const boot = source.slice(
		source.indexOf("  if (EVENTS && !EMBED?.presentationId)"),
		source.indexOf("  setInterval(popTick, 300);"),
	);

	it("coalesces refresh bursts through one cache-safe read", async () => {
		const timers: Array<() => void> = [];
		const loadAll = vi.fn().mockResolvedValue(undefined);
		const pollPopcorn = vi.fn().mockResolvedValue(undefined);
		const context = {
			bundleCache: {},
			Date,
			EVENT_READ_DELAY_MS: 600,
			EVENT_READ_JITTER_MS: 300,
			loadAll,
			Math: { ...Math, random: () => 0 },
			pollPopcorn,
			setTimeout: (callback: () => void) => {
				timers.push(callback);
				return timers.length;
			},
		};
		runInNewContext(
			`${schedulerSource}\n;globalThis.deckScheduler = { scheduleEventRefresh };`,
			context,
		);
		const schedule = (
			context as typeof context & {
				deckScheduler: { scheduleEventRefresh: () => void };
			}
		).deckScheduler.scheduleEventRefresh;

		schedule();
		schedule();
		schedule();
		expect(timers).toHaveLength(1);
		timers.shift()?.();
		await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
		expect(loadAll).toHaveBeenCalledOnce();
		expect(pollPopcorn).toHaveBeenCalledOnce();
	});

	it("does not open an EventSource or fallback poll inside a controlled iframe", () => {
		const followServerEvents = vi.fn();
		const setInterval = vi.fn();
		runInNewContext(boot, {
			EMBED: { presentationId: "room" },
			EVENTS: true,
			followServerEvents,
			LIVE: true,
			loadAll: vi.fn(),
			POLL_MS: 3000,
			pollPopcorn: vi.fn(),
			setInterval,
		});
		expect(followServerEvents).not.toHaveBeenCalled();
		expect(setInterval).not.toHaveBeenCalled();
	});

	it("keeps the standalone deck event stream", () => {
		const followServerEvents = vi.fn();
		runInNewContext(boot, {
			EMBED: { mode: "public" },
			EVENTS: true,
			followServerEvents,
			LIVE: true,
			loadAll: vi.fn(),
			POLL_MS: 3000,
			pollPopcorn: vi.fn(),
			setInterval: vi.fn(),
		});
		expect(followServerEvents).toHaveBeenCalledOnce();
	});

	it("leaves persistent chrome to the shell only for controlled embeds", () => {
		expect(styles).toContain(".present-shell .session-notice");
		expect(styles).toContain(".present-shell .colophon");
		expect(styles).toContain(".present-shell .qr-panel");
		expect(styles).not.toContain("body:not(.present-shell) .colophon");
	});
});
