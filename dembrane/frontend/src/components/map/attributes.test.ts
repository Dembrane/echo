import { i18n } from "@lingui/core";
import { beforeAll, describe, expect, it } from "vitest";
import {
	ATTRIBUTES,
	type AttributeInputs,
	conversationColor,
	isFactCheckEligible,
	legendEntries,
	MARKER_COLORS,
	OBJECT_TYPE_STYLES,
	OBJECT_TYPES,
	resolveAttribute,
	resolveMapColor,
	sizeScaleFor,
	stateLabels,
} from "./attributes";
import { getNodeStyle, getNodeStyleFromInputs } from "./graph/nodeStyle";
import type { FactCheckState, MapGraphNode } from "./types";

beforeAll(() => {
	i18n.load("en-US", {});
	i18n.activate("en-US");
});

const verdict = (value: "true" | "false" | "contested" | "unknown") =>
	({
		checkedAt: "",
		justification: "",
		sources: [],
		status: "done",
		verdict: value,
	}) satisfies FactCheckState;

const valenceOf = (inputs: AttributeInputs) =>
	resolveAttribute(ATTRIBUTES.valence, inputs);
const factualOf = (inputs: AttributeInputs) =>
	resolveAttribute(ATTRIBUTES.factCheck, inputs);

describe("valence", () => {
	it("shows a missing valence as Not assessed, apart from neutral", () => {
		const missing = valenceOf({ objectType: "argument" });
		const neutral = valenceOf({ objectType: "argument", valence: "neutral" });
		expect(missing).toMatchObject({
			key: "not_assessed",
			label: "Not assessed",
		});
		expect(neutral).toMatchObject({ key: "neutral", label: "Neutral" });
		expect(missing.color).not.toBe(neutral.color);
	});

	it.each(["tension", "stakeholder"] as const)(
		"does not apply to a %s",
		(objectType) => {
			expect(valenceOf({ objectType, valence: "positive" }).key).toBe(
				"not_applicable",
			);
		},
	);
});

describe("factual status", () => {
	it("distinguishes unverified, processing, verdicts and errors on a claim", () => {
		const claim: AttributeInputs = {
			epistemicKind: "claim",
			objectType: "argument",
		};
		expect(factualOf(claim).key).toBe("unverified");
		expect(factualOf({ ...claim, factCheck: { status: "idle" } }).key).toBe(
			"unverified",
		);
		const processing = factualOf({
			...claim,
			factCheck: { startedAt: "", status: "processing" },
		});
		expect(processing).toMatchObject({ key: "processing", pulse: true });
		expect(factualOf({ ...claim, factCheck: verdict("false") }).key).toBe(
			"false",
		);
		expect(
			factualOf({
				...claim,
				factCheck: { at: "", message: "x", status: "error" },
			}).key,
		).toBe("error");
	});

	it("is not applicable to arguments that are not claims", () => {
		expect(
			factualOf({ epistemicKind: "argument", objectType: "argument" }).key,
		).toBe("not_applicable");
	});

	it("checks deduplicated claims too", () => {
		expect(
			factualOf({
				epistemicKind: "claim",
				factCheck: verdict("true"),
				objectType: "deduplicated_argument",
			}).key,
		).toBe("true");
	});

	it.each(["tension", "stakeholder", "popcorn"] as const)(
		"never gives a %s a connected claim's verdict",
		(objectType) => {
			expect(
				factualOf({
					epistemicKind: "claim",
					factCheck: verdict("true"),
					objectType,
				}).key,
			).toBe("not_applicable");
		},
	);

	it("reads eligibility as a capability before the type name", () => {
		expect(
			isFactCheckEligible({
				epistemicKind: "claim",
				factCheckEligible: false,
				objectType: "argument",
			}),
		).toBe(false);
		// The deprecated kind still works while the renderers migrate.
		expect(isFactCheckEligible({ kind: "claim" })).toBe(true);
	});
});

describe("type styles", () => {
	it("draws tensions at 1.5 times the base radius and everything else at 1", () => {
		for (const type of OBJECT_TYPES) {
			expect(sizeScaleFor(type)).toBe(type === "tension" ? 1.5 : 1);
		}
	});

	it("gives every type its own colour", () => {
		const colours = new Set(
			OBJECT_TYPES.map((type) => OBJECT_TYPE_STYLES[type].color),
		);
		expect(colours.size).toBe(OBJECT_TYPES.length);
	});
});

describe("resolveMapColor", () => {
	const GRAPHITE = "#2D2D2C";
	const SOFT_PARCHMENT = "#B4B3B1";

	it("is the identity in light mode", () => {
		expect(resolveMapColor(GRAPHITE, false)).toBe(GRAPHITE);
		for (const type of OBJECT_TYPES) {
			const { color } = OBJECT_TYPE_STYLES[type];
			expect(resolveMapColor(color, false)).toBe(color);
		}
		for (const row of legendEntries("factCheck")) {
			expect(resolveMapColor(row.color, false)).toBe(row.color);
		}
	});

	it("lifts graphite to a soft parchment in dark mode", () => {
		expect(resolveMapColor(GRAPHITE, true)).toBe(SOFT_PARCHMENT);
		expect(resolveMapColor("#2d2d2c", true)).toBe(SOFT_PARCHMENT);
	});

	it("leaves every non-graphite palette entry alone in dark mode", () => {
		for (const colorBy of ["type", "valence", "factCheck"] as const) {
			for (const row of legendEntries(colorBy)) {
				if (row.color.toUpperCase() === GRAPHITE) continue;
				expect(resolveMapColor(row.color, true)).toBe(row.color);
			}
		}
	});
});

describe("legend", () => {
	it("renders nothing for None and every state for the others", () => {
		expect(legendEntries("none")).toEqual([]);
		expect(legendEntries("type").map((row) => row.key)).toEqual([
			...OBJECT_TYPES,
		]);
		expect(legendEntries("valence").map((row) => row.label)).toContain(
			"Not assessed",
		);
		expect(legendEntries("factCheck").map((row) => row.key)).toEqual(
			expect.arrayContaining([
				"not_applicable",
				"unverified",
				"processing",
				"true",
				"error",
			]),
		);
	});
});

describe("shared style resolver", () => {
	it("fills and labels a node from the active attribute", () => {
		const tension: Pick<MapGraphNode, "metadata"> = {
			metadata: {
				conversationIds: [],
				createdAt: null,
				kind: "argument",
				objectId: "t",
				objectType: "tension",
				quotes: [],
				revisionId: "t",
				sizeScale: 1.5,
			},
		};
		const style = getNodeStyle(tension, { colorBy: "type" });
		expect(style.fill).toBe(OBJECT_TYPE_STYLES.tension.color);
		expect(style.label).toBe("Tension");
		expect(getNodeStyle(tension, { colorBy: "valence" }).label).toBe(
			"Not applicable",
		);
	});

	it("keeps state labels inspectable for every attribute", () => {
		expect(
			stateLabels({ epistemicKind: "claim", objectType: "argument" }),
		).toMatchObject({
			factCheck: { label: "Unverified" },
			type: { label: "Argument" },
			valence: { label: "Not assessed" },
		});
		expect(getNodeStyleFromInputs({}, { colorBy: "none" }).pulse).toBe(false);
	});
});

describe("colouring by conversation", () => {
	it("gives a conversation the deck's own marker colour", () => {
		const inputs = { conversationSlots: [2], objectType: "argument" as const };
		const style = getNodeStyleFromInputs(inputs, { colorBy: "conversation" });
		// `--m2` in the deck's stylesheet, pinned in both themes.
		expect(style.fill).toBe("#FFC2FF");
		expect(
			getNodeStyleFromInputs(inputs, {
				colorBy: "conversation",
				darkMode: true,
			}).fill,
		).toBe("#FFC2FF");
		expect(style.label).toBe("Conversation 3");
		expect(style.blend).toEqual([]);
	});

	it("keeps generating colours past the six brand accents", () => {
		expect(conversationColor(6)).toBe("hsl(105 95% 80%)");
		expect(conversationColor(0)).toBe(MARKER_COLORS[0]);
	});

	it("blends a merge from its members' colours, weighted and in order", () => {
		const style = getNodeStyleFromInputs(
			{ conversationSlots: [1, 0, 1], objectType: "deduplicated_argument" },
			{ colorBy: "conversation" },
		);
		expect(style.blend).toEqual([
			MARKER_COLORS[0],
			MARKER_COLORS[1],
			MARKER_COLORS[1],
		]);
		// The flat fill stays the lowest slot, for anything that cannot blend.
		expect(style.fill).toBe(MARKER_COLORS[0]);
	});

	it("says so where the payload names no conversation", () => {
		const style = getNodeStyleFromInputs(
			{ conversationSlots: [], objectType: "argument" },
			{ colorBy: "conversation" },
		);
		expect(style.label).toBe("Source not recorded");
		expect(style.blend).toEqual([]);
	});
});
