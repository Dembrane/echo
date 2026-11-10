import type { TemplateSummary } from "@/components/project/templates/projectTemplates";
import type { DigestResult } from "./digest";

/**
 * The review screen's state (ECHO-1055): each part of the digest, on or off, as the host
 * edits it, and what Create sends. Pure, so the tests read it without a screen.
 */

export interface ReviewField<T> {
	on: boolean;
	value: T;
	/** The host changed it from what the digest proposed. */
	edited: boolean;
}

export interface ReviewState {
	name: string;
	nameEdited: boolean;
	goal: ReviewField<string>;
	context: ReviewField<string>;
	/** Proposed terms the host keeps, by their text. */
	keyTerms: ReviewField<string[]>;
	template: string | null;
	tags: ReviewField<string[]>;
	nameLabel: ReviewField<string>;
	verify: ReviewField<string[]>;
	explore: ReviewField<string>;
	hostSteps: ReviewField<string[]>;
}

export type SectionKey =
	| "goal"
	| "context"
	| "keyTerms"
	| "tags"
	| "nameLabel"
	| "verify"
	| "explore"
	| "hostSteps";

/** The sections that can be switched off, in the order the screen shows them. */
export const SECTIONS: readonly SectionKey[] = [
	"goal",
	"context",
	"keyTerms",
	"tags",
	"verify",
	"nameLabel",
	"explore",
	"hostSteps",
];

const field = <T>(value: T, on: boolean): ReviewField<T> => ({
	edited: false,
	on,
	value,
});

/** The template's own Verify topics, or the table check when it has none. */
export const templateTopics = (t: TemplateSummary | undefined) =>
	t?.summary.verification_topics.length
		? t.summary.verification_topics
		: ["agreements"];

/** What the review starts with: every part the digest returned, switched on. */
export function initialReview(
	r: DigestResult,
	templates: readonly TemplateSummary[] = [],
): ReviewState {
	const template = r.template?.key ?? null;
	const tpl = templates.find((t) => t.key === template);
	return {
		context: field(r.context ?? "", Boolean(r.context)),
		explore: field(r.explore_prompt ?? "", Boolean(r.explore_prompt)),
		goal: field(r.goal ?? "", Boolean(r.goal)),
		hostSteps: field(
			r.host_script_additions ?? [],
			Boolean(r.host_script_additions?.length),
		),
		keyTerms: field(
			r.key_terms.map((t) => t.term),
			r.key_terms.length > 0,
		),
		name: r.name ?? "",
		nameEdited: false,
		nameLabel: field(r.name_label ?? "", Boolean(r.name_label)),
		tags: field(r.tags ?? [], Boolean(r.tags?.length)),
		template,
		verify: field(
			r.verify_topics?.length ? r.verify_topics : templateTopics(tpl),
			true,
		),
	};
}

/** Which sections the digest returned something for: only those are shown. */
export function sectionsShown(r: DigestResult): SectionKey[] {
	return SECTIONS.filter((s) => {
		switch (s) {
			case "goal":
				return Boolean(r.goal);
			case "context":
				return Boolean(r.context);
			case "keyTerms":
				return r.key_terms.length > 0;
			case "tags":
				return Boolean(r.tags?.length);
			case "nameLabel":
				return Boolean(r.name_label);
			case "verify":
				return true;
			case "explore":
				return Boolean(r.explore_prompt);
			case "hostSteps":
				return Boolean(r.host_script_additions?.length);
			default:
				return false;
		}
	});
}

/** Sets one section's value and marks it edited. */
export function edit<K extends SectionKey>(
	s: ReviewState,
	key: K,
	value: ReviewState[K]["value"],
): ReviewState {
	return { ...s, [key]: { ...s[key], edited: true, value } };
}

export function toggle(
	s: ReviewState,
	key: SectionKey,
	on: boolean,
): ReviewState {
	return { ...s, [key]: { ...s[key], on } };
}

/** A new template keeps the host's Verify choice; an untouched one follows the template. */
export function chooseTemplate(
	s: ReviewState,
	key: string,
	templates: readonly TemplateSummary[],
	digestTopics: readonly string[] | undefined,
): ReviewState {
	const tpl = templates.find((t) => t.key === key);
	return {
		...s,
		template: key,
		verify: s.verify.edited
			? s.verify
			: {
					...s.verify,
					value: digestTopics?.length ? [...digestTopics] : templateTopics(tpl),
				},
	};
}

export interface DigestCreateBody {
	name: string;
	templateKey: string;
	digest: {
		context?: string;
		key_terms?: string[];
		tags?: string[];
		name_label?: string;
		verify_topics?: string[];
		explore_prompt?: string;
		host_script_additions?: string[];
		goal?: string;
	};
}

const text = (f: ReviewField<string>) =>
	f.on && f.value.trim() ? f.value.trim() : undefined;
const list = (f: ReviewField<string[]>) => {
	const items = f.value.map((x) => x.trim()).filter(Boolean);
	return f.on && items.length ? items : undefined;
};

/** What Create sends: the parts that are on and not empty, nothing else. */
export function toCreateBody(s: ReviewState): DigestCreateBody | null {
	if (!s.template || !s.name.trim()) return null;
	const digest = {
		context: text(s.context),
		explore_prompt: text(s.explore),
		goal: text(s.goal),
		host_script_additions: list(s.hostSteps),
		key_terms: list(s.keyTerms),
		name_label: text(s.nameLabel),
		tags: list(s.tags),
		verify_topics: list(s.verify),
	};
	return {
		digest: Object.fromEntries(
			Object.entries(digest).filter(([, v]) => v !== undefined),
		) as DigestCreateBody["digest"],
		name: s.name.trim(),
		templateKey: s.template,
	};
}

/** For analytics: how many shown parts were kept, edited and switched off. Counts only. */
export function appliedCounts(
	s: ReviewState,
	shown: readonly SectionKey[],
	proposedTemplate: string | null,
) {
	const on = shown.filter((k) => s[k].on);
	return {
		fields_accepted: on.length,
		fields_dropped: shown.length - on.length,
		fields_edited:
			on.filter((k) => s[k].edited).length + (s.nameEdited ? 1 : 0),
		template_changed: s.template !== proposedTemplate,
	};
}
