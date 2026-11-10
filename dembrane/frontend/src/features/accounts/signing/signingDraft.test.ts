import { describe, expect, it } from "vitest";
import {
	clearAllDrafts,
	clearDraft,
	draftKey,
	readDraft,
	type SigningDraft,
	writeDraft,
} from "./signingDraft";

/** A Storage over a Map, so the module is tested without a browser. */
const memory = () => {
	const map = new Map<string, string>();
	return {
		getItem: (k: string) => map.get(k) ?? null,
		key: (i: number) => [...map.keys()][i] ?? null,
		get length() {
			return map.size;
		},
		map,
		removeItem: (k: string) => {
			map.delete(k);
		},
		setItem: (k: string, v: string) => {
			map.set(k, v);
		},
	};
};

/** A Storage that refuses everything, as a private window or blocked site data can. */
const blocked = {
	getItem: () => {
		throw new Error("blocked");
	},
	key: () => {
		throw new Error("blocked");
	},
	get length(): number {
		throw new Error("blocked");
	},
	removeItem: () => {
		throw new Error("blocked");
	},
	setItem: () => {
		throw new Error("blocked");
	},
};

const fields = [
	{ id: "name", kind: "name" },
	{ id: "org", kind: "text" },
	{ id: "terms", kind: "checkbox" },
	{ id: "sig", kind: "signature" },
	{ id: "ini", kind: "initials" },
];
const expectFor = { fields, owner: "user-1", sha256: "abc" };
const draft = (over: Partial<SigningDraft> = {}): SigningDraft => ({
	current: "org",
	finishing: false,
	owner: "user-1",
	sha256: "abc",
	values: { name: "Ada Lovelace", org: "Gemeente Testdorp", terms: true },
	visited: ["name", "org"],
	...over,
});

describe("signing drafts", () => {
	it("puts back the values and the field the walk was on", () => {
		const s = memory();
		expect(writeDraft("doc-1", draft(), fields, [], s)).toBe(true);
		expect(readDraft("doc-1", expectFor, s)).toEqual(draft());
	});

	it("never keeps a signature or initials, nor anything that is not a plain value", () => {
		const s = memory();
		writeDraft(
			"doc-1",
			draft({
				values: {
					ini: "data:image/png;base64,BBBB",
					name: "Ada",
					other: "not a field",
					sig: "data:image/png;base64,AAAA",
				},
			}),
			fields,
			[],
			s,
		);
		const raw = s.map.get(draftKey("doc-1")) ?? "";
		expect(raw).not.toContain("base64");
		expect(raw).not.toContain("not a field");
		expect(readDraft("doc-1", expectFor, s)?.values).toEqual({ name: "Ada" });
		// Planted by hand, it is dropped on the way back in as well.
		s.setItem(
			draftKey("doc-1"),
			JSON.stringify({
				...draft(),
				values: {
					name: "Ada",
					sig: "data:image/png;base64,AAAA",
					org: { x: 1 },
				},
			}),
		);
		expect(readDraft("doc-1", expectFor, s)?.values).toEqual({ name: "Ada" });
	});

	it("keeps the extra step of an offer where one option is picked", () => {
		const s = memory();
		writeDraft(
			"doc-1",
			draft({ current: "pick", values: { pick: true } }),
			fields,
			["pick"],
			s,
		);
		const back = readDraft("doc-1", { ...expectFor, extraIds: ["pick"] }, s);
		expect(back?.current).toBe("pick");
		expect(back?.values).toEqual({ pick: true });
	});

	it("is someone else's after a change of user: dropped and removed", () => {
		const s = memory();
		writeDraft("doc-1", draft(), fields, [], s);
		expect(readDraft("doc-1", { ...expectFor, owner: "user-2" }, s)).toBeNull();
		expect(s.map.has(draftKey("doc-1"))).toBe(false);
	});

	it("starts clean when the document's file changed", () => {
		const s = memory();
		writeDraft("doc-1", draft(), fields, [], s);
		expect(readDraft("doc-1", { ...expectFor, sha256: "new" }, s)).toBeNull();
	});

	it("forgets a field the document no longer has", () => {
		const s = memory();
		writeDraft(
			"doc-1",
			draft({ current: "gone", visited: ["gone", "name"] }),
			fields,
			[],
			s,
		);
		const back = readDraft("doc-1", expectFor, s);
		expect(back?.current).toBeNull();
		expect(back?.visited).toEqual(["name"]);
	});

	it("drops what it cannot read", () => {
		const s = memory();
		s.setItem(draftKey("doc-1"), "{not json");
		expect(readDraft("doc-1", expectFor, s)).toBeNull();
		expect(s.map.has(draftKey("doc-1"))).toBe(false);
	});

	it("is cleared for one document once signed, and for all on a change of session", () => {
		const s = memory();
		writeDraft("doc-1", draft(), fields, [], s);
		writeDraft("doc-2", draft(), fields, [], s);
		s.setItem("dembrane_ws_selected", "ws");
		clearDraft("doc-1", s);
		expect(readDraft("doc-1", expectFor, s)).toBeNull();
		expect(readDraft("doc-2", expectFor, s)).not.toBeNull();
		clearAllDrafts(s);
		expect(readDraft("doc-2", expectFor, s)).toBeNull();
		// Only the drafts: the rest of the session stays.
		expect(s.getItem("dembrane_ws_selected")).toBe("ws");
	});

	it("works without storage: nothing kept, nothing thrown", () => {
		expect(writeDraft("doc-1", draft(), fields, [], blocked)).toBe(false);
		expect(readDraft("doc-1", expectFor, blocked)).toBeNull();
		expect(() => clearDraft("doc-1", blocked)).not.toThrow();
		expect(() => clearAllDrafts(blocked)).not.toThrow();
		expect(writeDraft("doc-1", draft(), fields, [], null)).toBe(false);
		expect(readDraft("doc-1", expectFor, null)).toBeNull();
	});
});
