import { t } from "@lingui/core/macro";
import { useQuery } from "@tanstack/react-query";
import { API_BASE_URL } from "@/config";
import { ApiRequestError } from "@/lib/errors/read";

/**
 * The templates a new project can start from (ECHO-1053: by purpose). The server holds the
 * settings and the card metadata (platform/packages/projects/src/project-templates.ts) and
 * says what each one sets up; the names, the "Great for" line and the tags are worded here.
 * Every string in this folder is in the templates catalog (./locales), loaded when the
 * picker opens, so none of it weighs on the participant portal's first load.
 */
export const CARD_KEYS = [
	"resident_evening",
	"round_table",
	"focus_group",
	"interviews",
	"kitchen_table",
	"strategy_day",
	"working_group",
	"retrospective",
	"ideation",
	"futures",
	"world_cafe",
	"open_space",
	"one_two_four_all",
	"conversation_cafe",
	"citizens_assembly",
	"conference",
] as const;
export type CardKey = (typeof CARD_KEYS)[number];

/** Keys from the first registry: valid for links and old projects, not offered as cards. */
const LEGACY_KEYS = ["conversation", "series", "event"] as const;
/** The quiet links under the cards. */
export const LINK_KEYS = ["upload", "blank"] as const;
export type LinkKey = (typeof LINK_KEYS)[number];

export const TEMPLATE_KEYS = [
	...CARD_KEYS,
	...LEGACY_KEYS,
	...LINK_KEYS,
] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export const isTemplateKey = (v: unknown): v is TemplateKey =>
	typeof v === "string" && (TEMPLATE_KEYS as readonly string[]).includes(v);

export const VERBS = [
	"gather",
	"understand",
	"explore",
	"align",
	"decide",
] as const;
export type Verb = (typeof VERBS)[number];
export const SETUPS = ["one_recording", "many_groups"] as const;
export type Setup = (typeof SETUPS)[number];

/** GET /v2/project-templates: what each template sets up and how it is offered. */
export interface TemplateSummary {
	key: string;
	version: number;
	landing: "home" | "upload";
	card: {
		offer: "card" | "link" | "none";
		verbs: Verb[];
		setup: Setup;
		sectors: string[];
		featured: boolean;
		method: string | null;
	};
	summary: {
		asks_for_name: boolean;
		asks_for_group_name: boolean;
		/** In the language asked for: what the portal's name box says. */
		name_label: string | null;
		tutorial: "none" | "basic" | "advanced";
		verify: boolean;
		verify_on_finish: boolean;
		verification_topics: string[];
		explore: boolean;
		explore_mode: "summarize" | "brainstorm" | "custom" | null;
		cross_pollination: boolean;
		auto_titles: boolean;
		tag_count: number;
		tags: string[];
		host_guide_title: string | null;
	};
}

async function fetchProjectTemplates(
	language: string,
): Promise<TemplateSummary[]> {
	const res = await fetch(
		`${API_BASE_URL}/v2/project-templates?language=${encodeURIComponent(language)}`,
		{ credentials: "include" },
	);
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new ApiRequestError(res.status, data);
	}
	const body = (await res.json()) as { templates: TemplateSummary[] };
	return body.templates;
}

/**
 * The same for everyone and changes only with a release. `language` is the new project's,
 * so the name box label, tags and host script title read as participants will see them.
 */
export const useProjectTemplates = (language: string) =>
	useQuery({
		queryFn: () => fetchProjectTemplates(language),
		queryKey: ["v2", "project-templates", language],
		staleTime: 60 * 60 * 1000,
	});

/**
 * A template's short name, on one axis: the conversation format, what happens in the room
 * (ECHO-1058). Occasions belong in the "Great for" line. Named methods keep their names.
 */
export const templateName = (key: TemplateKey): string => {
	switch (key) {
		case "resident_evening":
			return t`Table conversations`;
		case "round_table":
			return t`Round table`;
		case "focus_group":
			return t`Focus group`;
		case "interviews":
			return t`Interviews`;
		case "kitchen_table":
			return t`Kitchen-table conversation`;
		case "strategy_day":
			return t`Strategy session`;
		case "working_group":
			return t`Recurring meeting`;
		case "retrospective":
			return t`Retrospective`;
		case "ideation":
			return t`Brainstorm`;
		case "futures":
			return t`Scenario session`;
		case "world_cafe":
			return t`Rotating tables`;
		case "open_space":
			return t`Unconference`;
		case "one_two_four_all":
			return t`Everyone's ideas, fast`;
		case "conversation_cafe":
			return t`Calm conversation in rounds`;
		case "citizens_assembly":
			return t`Citizens' assembly`;
		case "conference":
			return t`Parallel sessions`;
		case "conversation":
			return t`One conversation`;
		case "series":
			return t`A series of sessions`;
		case "event":
			return t`A live event`;
		case "upload":
			return t`Recordings you already have`;
		case "blank":
			return t`Blank project`;
	}
};

/** One line: the occasions it is good for, then what sets the format apart. */
export const templateGreatFor = (key: CardKey): string => {
	switch (key) {
		case "resident_evening":
			return t`Great for resident evenings and public hearings: many fixed tables at once.`;
		case "round_table":
			return t`Great for partners or experts with different interests: one table, one recording.`;
		case "focus_group":
			return t`Great for youth panels and listening sessions: a moderator asks one small group.`;
		case "interviews":
			return t`Great for field and expert interviews: one to one, one after another.`;
		case "kitchen_table":
			return t`Great for home visits and sensitive topics: one calm talk at someone's table.`;
		case "strategy_day":
			return t`Great for strategy days and offsites: groups find themes, then agree on actions.`;
		case "working_group":
			return t`Great for teams and working groups: the same people, meeting after meeting, with minutes.`;
		case "retrospective":
			return t`Great for evaluating a project, pilot or event: one team looks back together.`;
		case "ideation":
			return t`Great for idea and innovation workshops: groups build on each other's ideas.`;
		case "futures":
			return t`Great for scenario planning and long-term visions: each group builds its own future.`;
		case "world_cafe":
			return t`Great for café rounds: people change tables, a table host stays and carries ideas along.`;
		case "open_space":
			return t`Great for an open agenda: participants propose sessions and move between them.`;
		case "one_two_four_all":
			return t`Great for hearing everyone in minutes: alone, in pairs, in fours, then all together.`;
		case "conversation_cafe":
			return t`Great for hard or charged topics: small circles where each person speaks in turn.`;
		case "citizens_assembly":
			return t`Great for deliberative panels, policy juries and participatory budgets: groups weigh options.`;
		case "conference":
			return t`Great for conferences and festivals: one recording per breakout or talk, side by side.`;
	}
};

/** The link under the cards, and its one line. */
export const linkLabel = (key: LinkKey): string =>
	key === "upload" ? t`Upload recordings` : t`Start blank`;
export const linkLine = (key: LinkKey): string =>
	key === "upload"
		? t`Analyse audio files you already have.`
		: t`Nothing set up. Choose every setting yourself.`;

/** A verb as the filter chip shows it. */
export const verbLabel = (verb: Verb): string => {
	switch (verb) {
		case "gather":
			return t`Gather`;
		case "understand":
			return t`Understand`;
		case "explore":
			return t`Explore`;
		case "align":
			return t`Align`;
		case "decide":
			return t`Decide`;
	}
};

/** The use-cases page's wording for a verb: the chip's tooltip. */
export const verbHint = (verb: Verb): string => {
	switch (verb) {
		case "gather":
			return t`Gathering expert knowledge`;
		case "understand":
			return t`Understanding what people think`;
		case "explore":
			return t`Exploring futures and possibilities`;
		case "align":
			return t`Aligning and moving forward`;
		case "decide":
			return t`Deciding together`;
	}
};

export const setupLabel = (setup: Setup): string =>
	setup === "one_recording" ? t`One recording` : t`Many groups at once`;

/** A Verify topic's name, as the portal shows it. */
export const topicLabel = (key: string): string => {
	switch (key) {
		case "agreements":
			return t`Table check`;
		case "disagreements":
			return t`Differences`;
		case "actions":
			return t`Decisions and actions`;
		case "gems":
			return t`Ideas worth keeping`;
		case "truths":
			return t`Hard points`;
		case "heard":
			return t`What we heard`;
		case "moments":
			return t`Turning points`;
		default:
			return key;
	}
};

/** The filters a host has on: one verb, one setup, or neither. */
export interface TemplateFilter {
	verb: Verb | null;
	setup: Setup | null;
}
export const NO_FILTER: TemplateFilter = { setup: null, verb: null };

/**
 * The cards to show: the featured ones until the host filters or asks for all, then every
 * card matching the filters, in the registry's order.
 */
export const visibleCards = (
	templates: readonly TemplateSummary[],
	filter: TemplateFilter,
	showAll: boolean,
): TemplateSummary[] => {
	const cards = CARD_KEYS.map((key) =>
		templates.find((tpl) => tpl.key === key && tpl.card.offer === "card"),
	).filter((tpl): tpl is TemplateSummary => !!tpl);
	const filtering = filter.verb !== null || filter.setup !== null;
	if (!filtering && !showAll) return cards.filter((tpl) => tpl.card.featured);
	return cards.filter(
		(tpl) =>
			(filter.verb === null || tpl.card.verbs.includes(filter.verb)) &&
			(filter.setup === null || tpl.card.setup === filter.setup),
	);
};

export const isCardKey = (v: unknown): v is CardKey =>
	typeof v === "string" && (CARD_KEYS as readonly string[]).includes(v);

/** A card's tags: the named method first if it follows one, then the verbs and the setup. */
export const cardTags = (tpl: TemplateSummary): string[] => [
	...(tpl.card.method ? [tpl.card.method] : []),
	...tpl.card.verbs.map(verbLabel),
	setupLabel(tpl.card.setup),
];

/** Every card in one row: the featured ones first, then the rest, each in registry order. */
export const rowCards = (
	templates: readonly TemplateSummary[],
): TemplateSummary[] => {
	const all = visibleCards(templates, NO_FILTER, true);
	return [
		...all.filter((tpl) => tpl.card.featured),
		...all.filter((tpl) => !tpl.card.featured),
	];
};
