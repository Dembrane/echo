import { t } from "@lingui/core/macro";
import {
	ArrowCounterClockwiseIcon,
	ArrowsClockwiseIcon,
	BinocularsIcon,
	ChatCenteredDotsIcon,
	ChatsCircleIcon,
	ClipboardTextIcon,
	CoffeeIcon,
	CompassIcon,
	HouseLineIcon,
	type Icon,
	LightbulbIcon,
	MicrophoneIcon,
	PresentationChartIcon,
	ScalesIcon,
	SquaresFourIcon,
	UsersFourIcon,
	UsersThreeIcon,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { API_BASE_URL } from "@/config";
import { ApiRequestError } from "@/lib/errors/read";

/**
 * The templates a new project can start from (ECHO-1053: by purpose). The server holds the
 * settings and the card metadata (platform/packages/projects/src/project-templates.ts) and
 * says what each one sets up; the names, the "Great for" line and the facts are worded here.
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

export const TEMPLATE_ICONS: Record<CardKey, Icon> = {
	citizens_assembly: ScalesIcon,
	conference: PresentationChartIcon,
	conversation_cafe: ChatCenteredDotsIcon,
	focus_group: ChatsCircleIcon,
	futures: BinocularsIcon,
	ideation: LightbulbIcon,
	interviews: MicrophoneIcon,
	kitchen_table: CoffeeIcon,
	one_two_four_all: UsersFourIcon,
	open_space: SquaresFourIcon,
	resident_evening: HouseLineIcon,
	retrospective: ArrowCounterClockwiseIcon,
	round_table: UsersThreeIcon,
	strategy_day: CompassIcon,
	working_group: ClipboardTextIcon,
	world_cafe: ArrowsClockwiseIcon,
};

/** A template's short name, as hosts call the occasion. */
export const templateName = (key: TemplateKey): string => {
	switch (key) {
		case "resident_evening":
			return t`Resident evening`;
		case "round_table":
			return t`Stakeholder round table`;
		case "focus_group":
			return t`Focus group`;
		case "interviews":
			return t`Interviews`;
		case "kitchen_table":
			return t`Kitchen-table conversation`;
		case "strategy_day":
			return t`Strategy day`;
		case "working_group":
			return t`Working group`;
		case "retrospective":
			return t`Evaluation`;
		case "ideation":
			return t`Ideation workshop`;
		case "futures":
			return t`Futures session`;
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
			return t`Conference sessions`;
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

/** One line on what it is good for, read in two seconds. */
export const templateGreatFor = (key: CardKey): string => {
	switch (key) {
		case "resident_evening":
			return t`Great for resident and neighbourhood evenings, and public hearings with many tables.`;
		case "round_table":
			return t`Great for one table of partners or experts with different interests.`;
		case "focus_group":
			return t`Great for focus groups, youth panels and small listening sessions.`;
		case "interviews":
			return t`Great for one-to-one, field and expert interviews, one after another.`;
		case "kitchen_table":
			return t`Great for home visits and sensitive conversations, one to one.`;
		case "strategy_day":
			return t`Great for strategy days, offsites and away days, from 20 to 175 people.`;
		case "working_group":
			return t`Great for team meetings and working groups that need minutes, meeting after meeting.`;
		case "retrospective":
			return t`Great for looking back after a project, a pilot or an event.`;
		case "ideation":
			return t`Great for idea and innovation workshops where groups build on each other.`;
		case "futures":
			return t`Great for scenario planning, co-design and long-term visions.`;
		case "world_cafe":
			return t`Great for café rounds where people change tables and carry ideas along.`;
		case "open_space":
			return t`Great for unconferences where participants set the agenda.`;
		case "one_two_four_all":
			return t`Great for hearing everyone in a few minutes: alone, in pairs, then in fours.`;
		case "conversation_cafe":
			return t`Great for talking in turns about a hard or charged topic.`;
		case "citizens_assembly":
			return t`Great for citizens' assemblies, deliberative panels, policy juries and participatory budgeting.`;
		case "conference":
			return t`Great for capturing breakouts and sessions across a conference.`;
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

const topicFact = (key: string, many: boolean): string | null => {
	switch (key) {
		case "agreements":
			return many
				? t`Each table checks its own summary`
				: t`The group checks the summary together`;
		case "disagreements":
			return t`Keeps the differences on the record`;
		case "actions":
			return t`Ends with decisions and actions`;
		case "gems":
			return t`Saves the ideas worth keeping`;
		case "truths":
			return t`Names the hard points`;
		case "heard":
			return t`Reads back what was heard`;
		case "moments":
			return t`Marks the turning points`;
		default:
			return null;
	}
};

/** Most facts a card shows. */
export const MAX_FACTS = 3;

/**
 * Up to three plain facts about what a template sets up, from its summary, most telling
 * first: what Verify gives back, what Explore does, then the portal. An upload says only
 * what an upload does.
 */
export const templateFacts = (tpl: TemplateSummary): string[] => {
	const s = tpl.summary;
	if (tpl.landing === "upload")
		return [t`Opens on the upload page`, t`Gives each recording a title`];
	const many = tpl.card.setup === "many_groups";
	const facts: string[] = [];
	if (s.verify) {
		const topics = s.verification_topics.length
			? s.verification_topics
			: ["agreements"];
		for (const key of topics.slice(0, 2)) {
			const fact = topicFact(key, many);
			if (fact) facts.push(fact);
		}
	}
	if (s.explore)
		facts.push(
			s.explore_mode === "brainstorm"
				? t`Offers "What if" questions when ideas run out`
				: t`Asks a question when the group gets stuck`,
		);
	if (s.cross_pollination) facts.push(t`Can bring in what other groups said`);
	if (s.tag_count > 0) facts.push(t`Rounds as tags`);
	const label = s.name_label;
	if (s.asks_for_name && label) facts.push(t`Asks for “${label}” first`);
	if (!s.asks_for_name) facts.push(t`Nothing to fill in before recording`);
	return facts.slice(0, MAX_FACTS);
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
