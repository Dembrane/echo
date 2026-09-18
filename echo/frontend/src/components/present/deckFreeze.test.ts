import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const source = readFileSync(
	new URL("../../../../server/dembrane/popcorn/static/app.js", import.meta.url),
	"utf8",
);
const freezeSource = source.slice(
	source.indexOf("  let quoteOpen = false, screenFrozen = false"),
	source.indexOf("  // only ever follow a link the data actually vouches for"),
);

function deck() {
	const rec: Record<string, unknown> = {
		el: { classList: { remove: () => {} } },
	};
	const context = {
		clearTimeout,
		Date,
		document: { querySelectorAll: () => [] },
		renderActive: () => {},
		setTimeout,
		state: { pop: { live: [rec] }, renderPending: false },
	};
	runInNewContext(
		`${freezeSource}\n;globalThis.api = { armPopTimer, freezeScreen };`,
		context,
	);
	const { api } = context as typeof context & {
		api: {
			armPopTimer: (
				rec: Record<string, unknown>,
				name: string,
				fn: () => void,
				delay: number,
			) => void;
			freezeScreen: (on: boolean, reason?: string) => void;
		};
	};
	return { api, rec };
}

afterEach(() => vi.useRealTimers());

describe("deck pause", () => {
	it("holds a timer armed during a pause and owes it in full on resume", () => {
		vi.useFakeTimers();
		const { api, rec } = deck();
		const handoff = vi.fn();

		api.freezeScreen(true, "shell");
		// A translation lands over SSE while the host has paused playback.
		api.armPopTimer(rec, "languageTimer", handoff, 4_500);
		vi.advanceTimersByTime(60_000);
		expect(handoff).not.toHaveBeenCalled();

		api.freezeScreen(false, "shell");
		vi.advanceTimersByTime(4_499);
		expect(handoff).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(handoff).toHaveBeenCalledOnce();
	});

	it("still suspends and resumes a timer that was already running", () => {
		vi.useFakeTimers();
		const { api, rec } = deck();
		const handoff = vi.fn();

		api.armPopTimer(rec, "languageTimer", handoff, 4_000);
		vi.advanceTimersByTime(1_000);
		api.freezeScreen(true, "shell");
		vi.advanceTimersByTime(30_000);
		expect(handoff).not.toHaveBeenCalled();

		api.freezeScreen(false, "shell");
		vi.advanceTimersByTime(3_000);
		expect(handoff).toHaveBeenCalledOnce();
	});
});
