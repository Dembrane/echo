import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const source = readFileSync(
	new URL("../../../../platform/packages/popcorn/static/app.js", import.meta.url),
	"utf8",
);
// The empty stage and the tick that fills it.
const waitingSource = source.slice(
	source.indexOf("  // The empty stage: a message, or the count to the first popcorn."),
	source.indexOf("  // Which phrase next."),
);

const WORDS: Record<string, string> = {
	"wait.checking": "checking for conversations…",
	"wait.empty.other": "read {n} conversations, nothing worth a popcorn yet",
	"wait.first": "waiting for the first conversation",
	"wait.reading": "reading the conversations…",
	"wait.slow": "the first popcorn is taking longer than usual",
};

interface Stage {
	innerHTML: string;
	waiting: { className: string; innerHTML: string } | null;
}

function deck(embed: Record<string, unknown> = { mode: "public" }) {
	const stage: Stage = { innerHTML: "", waiting: null };
	const stageEl = {
		appendChild: (el: Stage["waiting"]) => {
			stage.waiting = el;
		},
		get innerHTML() {
			return stage.innerHTML;
		},
		set innerHTML(v: string) {
			stage.innerHTML = v;
			if (!v) stage.waiting = null;
		},
		querySelector: () =>
			stage.waiting && {
				...stage.waiting,
				get innerHTML() {
					return stage.waiting?.innerHTML ?? "";
				},
				set innerHTML(v: string) {
					if (stage.waiting) stage.waiting.innerHTML = v;
				},
				remove: () => {
					stage.waiting = null;
				},
			},
	};
	const spawned: unknown[] = [];
	const state = {
		active: "popcorn",
		pop: {
			awaitingFirst: false,
			countdown: null as null | { startedAt: number },
			lastSpawn: 0,
			live: [] as unknown[],
			readingSince: 0,
		},
		popcorn: new Map<string, { done?: boolean; items?: unknown[] }>(),
		session: null as null | Record<string, unknown>,
	};
	const beacons: unknown[] = [];
	const context = {
		COUNTDOWN_MS: 3000,
		Date,
		document: {
			createElement: () => ({ className: "", innerHTML: "" }),
			getElementById: () => stageEl,
		},
		EMBED: embed,
		esc: (s: string) => s,
		HOST: embed.mode === "host",
		introOpen: false,
		LIVE: true,
		navigator: { sendBeacon: (...args: unknown[]) => beacons.push(args) },
		nextPopItem: () => ({ idx: 0, tid: "a" }),
		POP_CAP: 5,
		POP_GAP: 2400,
		POP_MAX: 3,
		SLOW_READ_MS: 45000,
		screenFrozen: false,
		spawnPop: (...args: unknown[]) => spawned.push(args),
		state,
		tr: (key: string) => WORDS[key] ?? key,
		trn: (key: string, n: number) =>
			(WORDS[`${key}.other`] ?? key).replace("{n}", String(n)),
	};
	runInNewContext(
		`const Blob = class {};\n${waitingSource}\n;globalThis.popTick = popTick;`,
		context,
	);
	const tick = () => (context as unknown as { popTick: () => void }).popTick();
	const text = () => stage.waiting?.innerHTML ?? "";
	return { beacons, spawned, state, text, tick };
}

afterEach(() => vi.useRealTimers());

describe("the room screen checks before it counts", () => {
	it("checks for conversations until the server says what the room waits on", () => {
		const d = deck();
		d.tick();
		expect(d.text()).toContain("checking for conversations…");
		d.state.session = { transcripts: [] };
		d.tick();
		expect(d.text()).toContain("checking for conversations…");
		expect(d.text()).toContain("spinner");
	});

	it("says so when there really are no conversations", () => {
		const d = deck();
		d.state.session = {
			transcripts: [],
			waiting: { being_read: 0, recording: 0 },
		};
		d.tick();
		expect(d.text()).toContain("waiting for the first conversation");
		expect(d.state.pop.countdown).toBeNull();
	});

	it("does not count while conversations are only being read", () => {
		const d = deck();
		d.state.session = {
			transcripts: [],
			waiting: { being_read: 2, recording: 0 },
		};
		d.tick();
		expect(d.text()).toContain("reading the conversations…");
		expect(d.text()).not.toContain("countdown");
		expect(d.state.pop.countdown).toBeNull();
	});

	it("counts 3, 2, 1 once the first phrase is in, holding it until the count ends", () => {
		vi.useFakeTimers();
		const d = deck();
		d.state.session = {
			transcripts: [{ id: "a" }],
			waiting: { being_read: 1, recording: 0 },
		};
		d.tick();
		expect(d.state.pop.awaitingFirst).toBe(true);
		d.state.session = { transcripts: [{ id: "a" }] };
		d.state.popcorn.set("a", { done: true, items: [{ phrase: "hello" }] });
		d.tick();
		expect(d.text()).toContain(">3<");
		expect(d.spawned).toHaveLength(0);
		vi.advanceTimersByTime(1000);
		d.tick();
		expect(d.text()).toContain(">2<");
		vi.advanceTimersByTime(2000);
		d.tick();
		expect(d.spawned).toHaveLength(1);
	});

	it("does not count on a deck that opens with phrases already up", () => {
		const d = deck();
		d.state.session = { transcripts: [{ id: "a" }] };
		d.state.popcorn.set("a", { done: true, items: [{ phrase: "hello" }] });
		d.tick();
		expect(d.state.pop.countdown).toBeNull();
		expect(d.spawned).toHaveLength(1);
	});

	it("says a slow first read is taking longer, and notes the latency for the host", () => {
		vi.useFakeTimers();
		const d = deck({ mode: "host" });
		d.state.session = {
			transcripts: [{ id: "a" }],
			waiting: { being_read: 1, recording: 0 },
		};
		d.tick();
		vi.advanceTimersByTime(46_000);
		d.tick();
		expect(d.text()).toContain("taking longer than usual");
		d.state.popcorn.set("a", { done: true, items: [{ phrase: "hello" }] });
		d.tick();
		expect(d.beacons).toHaveLength(1);
	});
});
