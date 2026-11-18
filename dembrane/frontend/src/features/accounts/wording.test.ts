import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The wording of the account area: "DPA", never the
// words spelled out, in every language; "dembrane" lowercase; no em dashes; and the
// room's own code never speaks of viewers or of who has seen what.

const here = path.dirname(fileURLToPath(import.meta.url));
const locales = path.join(here, "locales");

/** Every translation (msgstr) of a .po catalog, without its obsolete (#~) entries. */
const translations = (file: string): string[] => {
	const out: string[] = [];
	let current: string[] | null = null;
	for (const line of readFileSync(path.join(locales, file), "utf8").split(
		"\n",
	)) {
		if (line.startsWith("#~")) {
			current = null;
			continue;
		}
		const start = line.match(/^msgstr "(.*)"$/);
		if (start) {
			current = [start[1] ?? ""];
			out.push("");
		} else if (current && /^"(.*)"$/.test(line)) {
			current.push(line.slice(1, -1));
		} else if (current) {
			out[out.length - 1] = current.join("");
			current = null;
		}
	}
	if (current) out[out.length - 1] = current.join("");
	return out.filter(Boolean);
};

/** The spelled-out name of the agreement, per catalog: it is "DPA" everywhere. */
const SPELLED_OUT: Record<string, RegExp> = {
	"cs-CZ.po": /o zpracování osobních údajů/i,
	"de-DE.po": /Auftragsverarbeitungs(vertrag|vereinbarung)/i,
	"en-US.po": /data processing agreement/i,
	"es-ES.po": /acuerdo de (tratamiento|procesamiento) de datos/i,
	"fr-FR.po": /accord de traitement des données/i,
	"it-IT.po": /accordo sul trattamento dei dati/i,
	"nl-NL.po": /verwerkersovereenkomst/i,
	"uk-UA.po": /про обробку даних/i,
};

describe("the account area's words, in all eight languages", () => {
	it("has a catalog for each of the eight", () => {
		expect(
			readdirSync(locales)
				.filter((f) => f.endsWith(".po"))
				.sort(),
		).toEqual(Object.keys(SPELLED_OUT).sort());
	});

	it.each(Object.entries(SPELLED_OUT))(
		"%s says DPA, never the words spelled out",
		(file, spelled) => {
			const hits = translations(file).filter((s) => spelled.test(s));
			expect(hits).toEqual([]);
		},
	);

	it.each(Object.keys(SPELLED_OUT))(
		"%s has no em dash and writes dembrane lowercase",
		(file) => {
			const hits = translations(file).filter(
				(s) => s.includes("—") || /\bDembrane\b/.test(s),
			);
			expect(hits).toEqual([]);
		},
	);
});

describe("the room's own code", () => {
	const dir = path.join(here, "customer", "room");
	const sources = () =>
		readdirSync(dir).filter(
			(f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f),
		);

	it("exists, and never speaks of viewers, of who has seen what, or of the agreement spelled out", () => {
		expect(sources().length).toBeGreaterThan(0);
		for (const f of sources()) {
			const text = readFileSync(path.join(dir, f), "utf8");
			expect([f, /\bviewers?\b/i.test(text)]).toEqual([f, false]);
			expect([f, /seen by/i.test(text)]).toEqual([f, false]);
			expect([f, /data processing agreement/i.test(text)]).toEqual([f, false]);
			expect([f, text.includes("—")]).toEqual([f, false]);
		}
	});
});
