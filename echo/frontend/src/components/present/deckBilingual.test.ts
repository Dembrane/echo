import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(
	new URL("../../../../server/dembrane/popcorn/static/app.js", import.meta.url),
	"utf8",
);
const pollingSource = source.slice(
	source.indexOf("  function popcornSettled(data)"),
	source.indexOf("  // The phrase a live popcorn stands for"),
);

describe("vendored deck bilingual polling", () => {
	it("accepts a late translation at the same analysis revision and refreshes the stage", async () => {
		const original = {
			done: true,
			items: [{ id: "p1", phrase: "Samen maken we de buurt" }],
			revision: 7,
			validated: true,
		};
		const translated = {
			...original,
			items: [
				{
					...original.items[0],
					translation: "Together we shape the neighbourhood",
					translation_language: "en",
					translation_policy: "popcorn-room-v2",
					translation_ref: {
						revision: 7,
						source_key: "source-key",
					},
				},
			],
		};
		const state = {
			active: "popcorn",
			dropped: new Set<string>(),
			pop: {
				bilingualNext: new Map(),
				live: [],
				shownOriginal: new Map([["table-1:p1", original.items[0].phrase]]),
				shownTranslation: new Map(),
				tailStamp: "",
			},
			popcorn: new Map([["table-1", original]]),
			session: { transcripts: [{ id: "table-1" }] },
		};
		const renderPopTail = vi.fn();
		const refreshLivePops = vi.fn();
		const context = {
			bilingualKey: (tid: string, idx: number, item: { id?: string }) =>
				`${tid}:${item.id || idx}`,
			currentItem: vi.fn(),
			EMBED: { presentationId: "room" },
			fetchJson: vi.fn().mockResolvedValue(translated),
			// The deck's own helper: which languages this wording is still owed.
			owedLanguages: (
				key: string,
				item: { translation?: string; translation_language?: string },
			) => {
				const shown =
					(state.pop.shownTranslation.get(key) as
						| Record<string, string>
						| undefined) ?? {};
				return item.translation &&
					shown[item.translation_language ?? ""] !== item.translation
					? [{ language: item.translation_language, text: item.translation }]
					: [];
			},
			refreshLivePops,
			renderPopTail,
			renderProgress: vi.fn(),
			state,
		};
		runInNewContext(
			`${pollingSource}\n;state.pop.tailStamp = popcornStamp(); globalThis.pollingApi = { pollPopcorn };`,
			context,
		);

		await (
			context as typeof context & {
				pollingApi: { pollPopcorn: () => Promise<void> };
			}
		).pollingApi.pollPopcorn();

		expect(state.popcorn.get("table-1")).toEqual(translated);
		expect(renderPopTail).toHaveBeenCalledOnce();
		expect(refreshLivePops).toHaveBeenCalledOnce();

		const retargeted = {
			...translated,
			items: [
				{
					...translated.items[0],
					translation_language: "de",
					translation_policy: "popcorn-room-v3",
				},
			],
		};
		context.fetchJson.mockResolvedValue(retargeted);
		await (
			context as typeof context & {
				pollingApi: { pollPopcorn: () => Promise<void> };
			}
		).pollingApi.pollPopcorn();

		expect(state.popcorn.get("table-1")).toEqual(retargeted);
		expect(refreshLivePops).toHaveBeenCalledTimes(2);
	});
});
