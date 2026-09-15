import { i18n } from "@lingui/core";
import { beforeAll, describe, expect, it } from "vitest";
import {
	ATTRIBUTES,
	type AttributeInputs,
	isFactCheckEligible,
	legendEntries,
	OBJECT_TYPE_STYLES,
	OBJECT_TYPES,
	resolveAttribute,
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
