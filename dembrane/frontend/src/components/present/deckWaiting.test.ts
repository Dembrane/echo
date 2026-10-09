import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const source = readFileSync(
	new URL("../../../../platform/packages/popcorn/static/app.js", import.meta.url),
	"utf8",
);
// The empty stage, its Analyse now, and the tick that fills it.
const waitingSource = source.slice(
	source.indexOf("  // The waiting stage's Analyse now"),
	source.indexOf("  // Which phrase next."),
);

const WORDS: Record<string, string> = {
	"wait.analyseNow": "Analyse now",
	"wait.beingRead.other": "{n} finished, being read",
	"wait.checking": "checking for conversations…",
	"wait.empty.other": "read {n} conversations, nothing worth a popcorn yet",
	"wait.first": "waiting for the first conversation",
	"wait.reading": "reading the conversations…",
	"wait.recording.other": "conversations recording",
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
	const posts: unknown[] = [];
	const context = {
		COUNTDOWN_MS: 3000,
		Date,
		document: {
			createElement: () => ({ className: "", innerHTML: "" }),
			getElementById: () => stageEl,
		},
		EMBED: embed,
		esc: (s: string) => s,
		fetch: async (...args: unknown[]) => {
			posts.push(args);
			return { ok: true };
		},
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
		`const Blob = class {};\n${waitingSource}\n;globalThis.popTick = popTick; globalThis.analyseNow = analyseNow;`,
		context,
	);
	const tick = () => (context as unknown as { popTick: () => void }).popTick();
	const text = () => stage.waiting?.innerHTML ?? "";
	const analyseNow = () =>
		(context as unknown as { analyseNow: () => Promise<void> }).analyseNow();
	return { analyseNow, beacons, posts, spawned, state, text, tick };
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
		// Nothing recording: one line, no large zero.
		expect(d.text()).toContain("2 finished, being read");
		expect(d.text()).not.toContain("waiting-count");
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

describe("the waiting stage shows the count", () => {
	const waitingFor = (recording: number, beingRead: number) => ({
		transcripts: [],
		waiting: { being_read: beingRead, recording },
	});

	it("shows the conversations recording, large, and the finished ones being read beneath", () => {
		const d = deck();
		d.state.session = waitingFor(3, 1);
		d.tick();
		expect(d.text()).toContain('<p class="waiting-count">3</p>');
		expect(d.text()).toContain("conversations recording");
		expect(d.text()).toContain("recording-dot");
		expect(d.text()).toContain('<p class="waiting-sub">1 finished, being read</p>');
	});

	it("never draws Analyse now on the public page", () => {
		const d = deck({ mode: "public" });
		d.state.session = waitingFor(3, 1);
		d.tick();
		expect(d.text()).not.toContain("Analyse now");
	});

	it("gives the host Analyse now, which runs a read straight away", async () => {
		const d = deck({ analyseNow: "../refresh", mode: "host" });
		d.state.session = waitingFor(2, 0);
		d.tick();
		expect(d.text()).toContain('class="analyse-now"');
		const read = d.analyseNow();
		expect(d.text()).toContain("disabled");
		await read;
		expect(d.posts).toEqual([
			["../refresh", { credentials: "include", method: "POST" }],
		]);
		expect(d.text()).not.toContain("disabled");
	});

	it("draws no Analyse now while it is still checking", () => {
		const d = deck({ analyseNow: "../refresh", mode: "public" });
		d.state.session = { transcripts: [] };
		d.tick();
		expect(d.text()).not.toContain("Analyse now");
	});
});
