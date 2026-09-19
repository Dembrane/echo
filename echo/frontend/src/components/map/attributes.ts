import { t } from "@lingui/core/macro";
import { baseColors, stateColors } from "@/colors";
import type {
	ColorBy,
	FactCheckState,
	MapEpistemicKind,
	MapGraphNode,
	MapKind,
	MapValence,
	ObjectType,
} from "./types";

// ---------------------------------------------------------------------------
// Palette. These greys have no named brand colour; every other map colour
// comes from @/colors.
// ---------------------------------------------------------------------------

export const MAP_NEUTRAL_GREY = "#9CA3AF";
/** A value that was never assessed: lighter than neutral, so the two differ. */
export const MAP_NOT_ASSESSED_GREY = "#E5E7EB";
/** An attribute that does not apply to the node's type. */
export const MAP_NOT_APPLICABLE_GREY = "#CBD5E1";

/**
 * Graphite is the ink of a parchment page. On the room screen's near-black
 * background it all but disappears, so dark mode lifts it to a softened
 * parchment: bright enough to see, quiet enough to keep reading as "we do
 * not know" beside the brighter verdict colours.
 */
// Soft parchment (70% of it over the dark room), as an opaque colour: a
// see-through node would let the tree's edges show through it.
export const MAP_DARK_GRAPHITE = "#B4B3B1";

/**
 * Colours whose light-page value has no contrast on a dark room screen, with
 * what they become there. Every other palette value already carries its own
 * contrast and passes through untouched.
 */
const DARK_LIFTS: Readonly<Record<string, string>> = {
	[baseColors.graphite]: MAP_DARK_GRAPHITE,
};

/**
 * One palette colour as the current theme draws it. Light mode is the
 * identity, so the host's Map page is unchanged.
 */
export const resolveMapColor = (color: string, darkMode: boolean): string =>
	(darkMode ? DARK_LIFTS[color.toUpperCase()] : undefined) ?? color;

// ---------------------------------------------------------------------------
// Object types
// ---------------------------------------------------------------------------

/** Every map-capable object type, in the order the Objects filter lists them. */
export const OBJECT_TYPES: ReadonlyArray<ObjectType> = [
	"argument",
	"deduplicated_argument",
	"popcorn",
	"tension",
	"stakeholder",
];

export const isObjectType = (value: unknown): value is ObjectType =>
	typeof value === "string" &&
	(OBJECT_TYPES as ReadonlyArray<string>).includes(value);

export type ObjectTypeStyle = {
	type: ObjectType;
	/** Node radius multiplier. It distinguishes type, not importance. */
	sizeScale: number;
	color: string;
	label: () => string;
	pluralLabel: () => string;
	/** The action that creates objects of this type. */
	generateLabel: () => string;
	/** Shown when a checked type has no saved objects. */
	emptyLabel: () => string;
};

export const OBJECT_TYPE_STYLES: Readonly<Record<ObjectType, ObjectTypeStyle>> =
	{
		argument: {
			// Grey keeps an argument-only map looking as it did before types.
			color: MAP_NEUTRAL_GREY,
			emptyLabel: () => t`No arguments saved yet.`,
			generateLabel: () => t`Generate map`,
			label: () => t`Argument`,
			pluralLabel: () => t`Arguments`,
			sizeScale: 1,
			type: "argument",
		},
		deduplicated_argument: {
			color: baseColors.institutionBlue,
			emptyLabel: () => t`No deduplicated arguments saved yet.`,
			generateLabel: () => t`Deduplicate arguments`,
			label: () => t`Deduplicated argument`,
			pluralLabel: () => t`Deduplicated arguments`,
			sizeScale: 1,
			type: "deduplicated_argument",
		},
		popcorn: {
			color: baseColors.limeYellow,
			emptyLabel: () => t`No popcorn saved yet.`,
			generateLabel: () => t`Generate popcorn`,
			label: () => t`Popcorn`,
			pluralLabel: () => t`Popcorn`,
			sizeScale: 1,
			type: "popcorn",
		},
		stakeholder: {
			color: baseColors.mauve,
			emptyLabel: () => t`No stakeholders saved yet.`,
			generateLabel: () => t`Generate stakeholders`,
			label: () => t`Stakeholder`,
			pluralLabel: () => t`Stakeholders`,
			sizeScale: 1,
			type: "stakeholder",
		},
		tension: {
			color: baseColors.salmon,
			emptyLabel: () => t`No tensions saved yet.`,
			generateLabel: () => t`Generate tensions`,
			label: () => t`Tension`,
			pluralLabel: () => t`Tensions`,
			sizeScale: 1.5,
			type: "tension",
		},
	};

export const sizeScaleFor = (type: ObjectType | undefined): number =>
	(type && OBJECT_TYPE_STYLES[type]?.sizeScale) || 1;

/** Types whose claims can be fact-checked. */
export const FACT_CHECKABLE_TYPES: ReadonlySet<ObjectType> = new Set([
	"argument",
	"deduplicated_argument",
]);

// ---------------------------------------------------------------------------
// Attribute inputs
// ---------------------------------------------------------------------------

/** The node metadata an attribute reads. Every field may be absent. */
export type AttributeInputs = {
	objectType?: ObjectType;
	epistemicKind?: MapEpistemicKind;
	/** @deprecated read through `epistemicKind`. */
	kind?: MapKind;
	valence?: MapValence;
	factCheck?: FactCheckState;
	factCheckEligible?: boolean;
};

export const attributeInputsOf = (
	metadata: Partial<MapGraphNode["metadata"]> | undefined,
): AttributeInputs => ({
	epistemicKind: metadata?.epistemicKind,
	factCheck: metadata?.factCheck,
	factCheckEligible: metadata?.factCheckEligible,
	kind: metadata?.kind,
	objectType: metadata?.objectType,
	valence: metadata?.valence,
});

export const epistemicKindOf = (
	inputs: AttributeInputs,
): MapEpistemicKind | undefined => inputs.epistemicKind ?? inputs.kind;

/**
 * Fact-check eligibility is a capability. The payload states it; without it,
 * claims of the argument types are eligible and nothing else is.
 */
export const isFactCheckEligible = (inputs: AttributeInputs): boolean => {
	if (typeof inputs.factCheckEligible === "boolean") {
		return inputs.factCheckEligible;
	}
	return (
		epistemicKindOf(inputs) === "claim" &&
		FACT_CHECKABLE_TYPES.has(inputs.objectType ?? "argument")
	);
};

export type DisplayVerdict =
	| "true"
	| "false"
	| "contested"
	| "unknown"
	| "processing";

export const deriveDisplayVerdict = (
	factCheck: FactCheckState | undefined,
): DisplayVerdict => {
	if (!factCheck) return "unknown";
	switch (factCheck.status) {
		case "done":
			return factCheck.verdict;
		case "processing":
			return "processing";
		default:
			return "unknown";
	}
};

// ---------------------------------------------------------------------------
// Attribute definitions
// ---------------------------------------------------------------------------

export type AttributeValue = {
	key: string;
	label: string;
	color: string;
	pulse: boolean;
};

export type LegendEntry = { key: string; label: string; color: string };

export type AttributeDefinition = {
	id: ColorBy;
	label: () => string;
	valueType: "category" | "numeric";
	/** Types the attribute describes; other types resolve to `notApplicable`. */
	appliesTo: ReadonlyArray<ObjectType>;
	/** The category key of an applicable node, or undefined when missing. */
	accessor: (inputs: AttributeInputs) => string | undefined;
	/** Key used when an applicable node has no value. */
	missing: string;
	notApplicable: string;
	palette: Readonly<Record<string, string>>;
	/** Keys whose nodes pulse, such as a check in flight. */
	pulsing?: ReadonlySet<string>;
	/** Label per key, in legend order. */
	entries: () => ReadonlyArray<{ key: string; label: string }>;
	/** Keys the legend lists; defaults to every entry. */
	legendKeys?: ReadonlyArray<string>;
};

const NONE: AttributeDefinition = {
	accessor: () => "none",
	appliesTo: OBJECT_TYPES,
	entries: () => [{ key: "none", label: t`No colour` }],
	id: "none",
	label: () => t`None`,
	legendKeys: [],
	missing: "none",
	notApplicable: "none",
	palette: { none: MAP_NEUTRAL_GREY },
	valueType: "category",
};

const TYPE: AttributeDefinition = {
	accessor: (inputs) => inputs.objectType ?? "argument",
	appliesTo: OBJECT_TYPES,
	entries: () =>
		OBJECT_TYPES.map((type) => ({
			key: type,
			label: OBJECT_TYPE_STYLES[type].label(),
		})),
	id: "type",
	label: () => t`Type`,
	missing: "argument",
	notApplicable: "argument",
	palette: Object.fromEntries(
		OBJECT_TYPES.map((type) => [type, OBJECT_TYPE_STYLES[type].color]),
	),
	valueType: "category",
};

const VALENCE: AttributeDefinition = {
	accessor: (inputs) => inputs.valence,
	appliesTo: ["argument", "deduplicated_argument", "popcorn"],
	entries: () => [
		{ key: "positive", label: t`Positive` },
		{ key: "negative", label: t`Negative` },
		{ key: "neutral", label: t`Neutral` },
		{ key: "not_assessed", label: t`Not assessed` },
		{ key: "not_applicable", label: t`Not applicable` },
	],
	id: "valence",
	label: () => t`Valence`,
	missing: "not_assessed",
	notApplicable: "not_applicable",
	palette: {
		negative: baseColors.salmon,
		neutral: MAP_NEUTRAL_GREY,
		not_applicable: MAP_NOT_APPLICABLE_GREY,
		not_assessed: MAP_NOT_ASSESSED_GREY,
		positive: baseColors.springGreen,
	},
	valueType: "category",
};

const FACTUAL_STATUS: AttributeDefinition = {
	accessor: (inputs) => {
		if (!isFactCheckEligible(inputs)) return "not_applicable";
		const state = inputs.factCheck;
		if (!state || state.status === "idle") return "unverified";
		if (state.status === "processing") return "processing";
		if (state.status === "error") return "error";
		return state.verdict;
	},
	// A stakeholder or tension never inherits a connected claim's verdict.
	appliesTo: ["argument", "deduplicated_argument"],
	entries: () => [
		{ key: "not_applicable", label: t`Not applicable` },
		{ key: "true", label: t`Likely true` },
		{ key: "false", label: t`Likely false` },
		{ key: "contested", label: t`Contested` },
		{ key: "unknown", label: t`Inconclusive` },
		{ key: "unverified", label: t`Unverified` },
		{ key: "processing", label: t`Checking…` },
		{ key: "error", label: t`Check failed` },
	],
	id: "factCheck",
	label: () => t`Factual status`,
	missing: "unverified",
	notApplicable: "not_applicable",
	palette: {
		contested: baseColors.limeYellow,
		error: stateColors.errorMark,
		false: baseColors.salmon,
		// Grey, as arguments were before types, and apart from "likely true".
		not_applicable: MAP_NEUTRAL_GREY,
		processing: baseColors.institutionBlue,
		true: baseColors.springGreen,
		unknown: baseColors.graphite,
		unverified: baseColors.graphite,
	},
	pulsing: new Set(["processing"]),
	valueType: "category",
};

export const ATTRIBUTES: Readonly<Record<ColorBy, AttributeDefinition>> = {
	factCheck: FACTUAL_STATUS,
	none: NONE,
	type: TYPE,
	valence: VALENCE,
};

/** Colour modes in the order the settings menu offers them. */
export const COLOR_BY_OPTIONS: ReadonlyArray<ColorBy> = [
	"none",
	"type",
	"valence",
	"factCheck",
];

export const attributeFor = (colorBy: ColorBy): AttributeDefinition =>
	ATTRIBUTES[colorBy] ?? NONE;

const labelFor = (definition: AttributeDefinition, key: string): string =>
	definition.entries().find((entry) => entry.key === key)?.label ?? key;

/** The value, label and colour one node shows for one attribute. */
export function resolveAttribute(
	definition: AttributeDefinition,
	inputs: AttributeInputs,
): AttributeValue {
	const type = inputs.objectType ?? "argument";
	let key: string;
	if (!definition.appliesTo.includes(type)) {
		key = definition.notApplicable;
	} else {
		key = definition.accessor(inputs) ?? definition.missing;
		if (!(key in definition.palette)) key = definition.missing;
	}
	return {
		color: definition.palette[key] ?? MAP_NEUTRAL_GREY,
		key,
		label: labelFor(definition, key),
		pulse: definition.pulsing?.has(key) ?? false,
	};
}

/** The legend rows of a colour mode; empty for None. */
export function legendEntries(colorBy: ColorBy): LegendEntry[] {
	const definition = attributeFor(colorBy);
	const keys = definition.legendKeys;
	return definition
		.entries()
		.filter((entry) => !keys || keys.includes(entry.key))
		.map((entry) => ({
			color: definition.palette[entry.key] ?? MAP_NEUTRAL_GREY,
			key: entry.key,
			label: entry.label,
		}));
}

/** Every attribute's state label for a node, so colours stay inspectable. */
export function stateLabels(inputs: AttributeInputs): {
	type: AttributeValue;
	valence: AttributeValue;
	factCheck: AttributeValue;
} {
	return {
		factCheck: resolveAttribute(FACTUAL_STATUS, inputs),
		type: resolveAttribute(TYPE, inputs),
		valence: resolveAttribute(VALENCE, inputs),
	};
}
