import { plural, t } from "@lingui/core/macro";
import {
	CalendarDotsIcon,
	ChatCircleIcon,
	type Icon,
	UploadSimpleIcon,
	UsersThreeIcon,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { API_BASE_URL } from "@/config";
import { ApiRequestError } from "@/lib/errors/read";

/**
 * The templates a new project can start from. The server holds the settings
 * (platform/packages/projects/src/project-templates.ts) and says what each one sets up;
 * the names, the "when to pick it" line and the facts are worded here.
 */
export const TEMPLATE_KEYS = [
	"conversation",
	"series",
	"event",
	"upload",
	"blank",
] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export const isTemplateKey = (v: unknown): v is TemplateKey =>
	typeof v === "string" && (TEMPLATE_KEYS as readonly string[]).includes(v);

/** GET /v2/project-templates: what each template sets up. */
export interface TemplateSummary {
	key: string;
	version: number;
	landing: "home" | "upload";
	summary: {
		asks_for_name: boolean;
		asks_for_group_name: boolean;
		tutorial: "none" | "basic" | "advanced";
		verify: boolean;
		verify_on_finish: boolean;
		verification_topics: string[];
		explore: boolean;
		auto_titles: boolean;
		tag_count: number;
	};
}

async function fetchProjectTemplates(): Promise<TemplateSummary[]> {
	const res = await fetch(`${API_BASE_URL}/v2/project-templates`, {
		credentials: "include",
	});
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new ApiRequestError(res.status, data);
	}
	const body = (await res.json()) as { templates: TemplateSummary[] };
	return body.templates;
}

/** The same for everyone and changes only with a release. */
export const useProjectTemplates = () =>
	useQuery({
		queryFn: fetchProjectTemplates,
		queryKey: ["v2", "project-templates"],
		staleTime: 60 * 60 * 1000,
	});

/** The cards, in the order they are offered; blank is the quiet option below them. */
export const CARD_KEYS: readonly Exclude<TemplateKey, "blank">[] = [
	"conversation",
	"series",
	"event",
	"upload",
];

export const TEMPLATE_ICONS: Record<Exclude<TemplateKey, "blank">, Icon> = {
	conversation: ChatCircleIcon,
	event: UsersThreeIcon,
	series: CalendarDotsIcon,
	upload: UploadSimpleIcon,
};

/** A template's short name. */
export const templateName = (key: TemplateKey): string => {
	switch (key) {
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

/** One line on when to pick it. */
export const templateWhen = (key: TemplateKey): string => {
	switch (key) {
		case "conversation":
			return t`An interview or a meeting, recorded on one device.`;
		case "series":
			return t`Recurring meetings or a working group, all in one project.`;
		case "event":
			return t`Many tables or groups talking at the same time, each on a phone.`;
		case "upload":
			return t`Upload audio files and analyse what was said.`;
		case "blank":
			return t`Nothing set up. Choose every setting yourself.`;
	}
};

/** Most facts a card shows. */
export const MAX_FACTS = 3;

/**
 * Up to three plain facts about what a template sets up, from its summary, most telling
 * first. Feature names hosts meet later in the portal editor come after what they do.
 */
export const templateFacts = (t_: TemplateSummary): string[] => {
	const s = t_.summary;
	const facts: string[] = [];
	if (t_.landing === "upload") facts.push(t`Opens on the upload page`);
	if (s.asks_for_group_name) facts.push(t`Asks each table for its name`);
	if (s.verify)
		facts.push(t`Tables check and approve their own outcome (Verify)`);
	if (s.explore)
		facts.push(t`Participants can ask for a question to go deeper (Explore)`);
	if (s.tag_count > 0)
		facts.push(
			plural(s.tag_count, {
				one: "Adds # tag to pick when recording starts",
				other: "Adds # tags to pick when recording starts",
			}),
		);
	if (s.tutorial !== "none")
		facts.push(t`Shows participants a short tutorial first`);
	if (s.auto_titles) facts.push(t`Gives each conversation a title`);
	if (!s.asks_for_name) facts.push(t`Nothing to fill in before recording`);
	else if (!s.asks_for_group_name)
		facts.push(t`Asks for a session name before recording`);
	return facts.slice(0, MAX_FACTS);
};
