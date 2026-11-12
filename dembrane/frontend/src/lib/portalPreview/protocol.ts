/**
 * The portal preview's messages (ECHO-1060), shared by the dashboard, which sends a host's
 * unsaved values, and the portal, which shows them in a participant screen.
 *
 * Both ends check the other's origin against the configured dashboard and portal URLs and
 * read nothing else. Everything a message carries is untrusted: parsePreviewMessage keeps
 * only the known fields, each with its type and a length cap, and the portal renders them as
 * text (React escapes them; Markdown fields go through the same renderer as the live portal,
 * which renders no raw HTML).
 */

export const PREVIEW_MESSAGE = "dembrane:portal-preview";
export const PREVIEW_READY = "dembrane:portal-preview-ready";
export const PREVIEW_VERSION = 2;

/** The participant screens the preview can show. */
export const PREVIEW_SCREENS = [
	"landing",
	"tutorial",
	"privacy",
	"form",
	"recording",
	"explore",
	"verify-topics",
	"verify-summary",
	"finish",
] as const;
export type PreviewScreen = (typeof PREVIEW_SCREENS)[number];

/** Parts of a screen the open option changes: the preview outlines the first one shown. */
export const PREVIEW_HIGHLIGHTS = [
	"title",
	"description",
	"tutorial",
	"privacy",
	"name",
	"tags",
	"explore",
	"verify-topics",
	"verify-summary",
	"finish-text",
	"notifications",
	"event-cta",
] as const;
export type PreviewHighlight = (typeof PREVIEW_HIGHLIGHTS)[number];

export const PREVIEW_LANGUAGES = [
	"en",
	"nl",
	"de",
	"fr",
	"es",
	"it",
	"uk",
	"cs",
] as const;

export const LEGAL_BASES = [
	"client-managed",
	"consent",
	"dembrane-events",
] as const;

/** What a participant screen reads from the project, and nothing more. */
export interface PreviewProject {
	language: (typeof PREVIEW_LANGUAGES)[number];
	default_conversation_title: string;
	default_conversation_description: string;
	default_conversation_finish_text: string;
	default_conversation_tutorial_slug: "none" | "basic" | "advanced";
	default_conversation_ask_for_participant_name: boolean;
	conversation_ask_for_participant_name_label: string;
	default_conversation_ask_for_participant_email: boolean;
	is_project_notification_subscription_allowed: boolean;
	is_dembrane_event_cta_enabled: boolean;
	is_get_reply_enabled: boolean;
	is_verify_enabled: boolean;
	is_verify_on_finish_enabled: boolean;
	anonymize_transcripts: boolean;
	legal_basis: (typeof LEGAL_BASES)[number];
	privacy_policy_url: string | null;
	organiser_name: string | null;
	tags: { id: string; text: string }[];
}

export interface PreviewTopic {
	key: string;
	/** The topic's name in the portal's language. */
	label: string;
}

/**
 * A result shown in place of a model's: a hand-written example, or a real model result
 * from "Try it" (ECHO-1061) with source "model".
 */
export interface PreviewResult {
	source: "example" | "model";
	/** The Verify topic or Explore mode it belongs to. */
	key: string;
	text: string;
}

export interface PreviewMessage {
	type: typeof PREVIEW_MESSAGE;
	version: typeof PREVIEW_VERSION;
	screen: PreviewScreen;
	project: PreviewProject;
	/** The Verify topics participants can choose, in order. */
	topics: PreviewTopic[];
	/**
	 * The Explore reply and the Verify draft the screens show, whichever screen is open, so
	 * the host can click through to either (ECHO-1062).
	 */
	explore: PreviewResult | null;
	verify: PreviewResult | null;
	highlight: PreviewHighlight | null;
	/**
	 * Counts the host's moves in the editor (opening or editing an option, picking a screen,
	 * trying a setting, ECHO-1062). A new count starts the screen again, so the phone returns
	 * to it after the host clicked onward inside it.
	 */
	reset: number;
}

export const LIMITS = {
	label: 80,
	longText: 20_000,
	tags: 100,
	tagText: 200,
	title: 500,
	topics: 50,
	url: 2_000,
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const text = (v: unknown, max: number): string | null =>
	typeof v === "string" && v.length <= max ? v : null;

const oneOf = <T extends string>(v: unknown, values: readonly T[]): T | null =>
	typeof v === "string" && (values as readonly string[]).includes(v)
		? (v as T)
		: null;

/** The URL when it is an http(s) address the preview may show as a link, else null. */
export const webUrl = (v: string | null | undefined): string | null => {
	if (!v || v.length > LIMITS.url) return null;
	try {
		const url = new URL(v);
		return url.protocol === "https:" || url.protocol === "http:" ? v : null;
	} catch {
		return null;
	}
};

const httpsUrl = (v: unknown): string | null | undefined => {
	if (v === null) return null;
	const s = text(v, LIMITS.url);
	if (s === null) return undefined;
	try {
		const url = new URL(s);
		return url.protocol === "https:" || url.protocol === "http:"
			? s
			: undefined;
	} catch {
		return undefined;
	}
};

const BOOLEAN_FIELDS = [
	"default_conversation_ask_for_participant_name",
	"default_conversation_ask_for_participant_email",
	"is_project_notification_subscription_allowed",
	"is_dembrane_event_cta_enabled",
	"is_get_reply_enabled",
	"is_verify_enabled",
	"is_verify_on_finish_enabled",
	"anonymize_transcripts",
] as const;

function parseProject(v: unknown): PreviewProject | null {
	if (!isRecord(v)) return null;
	const language = oneOf(v.language, PREVIEW_LANGUAGES);
	const tutorial = oneOf(v.default_conversation_tutorial_slug, [
		"none",
		"basic",
		"advanced",
	] as const);
	const legal = oneOf(v.legal_basis, LEGAL_BASES);
	const title = text(v.default_conversation_title, LIMITS.title);
	const description = text(v.default_conversation_description, LIMITS.longText);
	const finish = text(v.default_conversation_finish_text, LIMITS.longText);
	const nameLabel = text(
		v.conversation_ask_for_participant_name_label,
		LIMITS.label,
	);
	const policy = httpsUrl(v.privacy_policy_url);
	const organiser =
		v.organiser_name === null ? null : text(v.organiser_name, LIMITS.title);
	if (
		!language ||
		!tutorial ||
		!legal ||
		title === null ||
		description === null ||
		finish === null ||
		nameLabel === null ||
		policy === undefined ||
		(v.organiser_name !== null && organiser === null)
	)
		return null;
	const booleans: Partial<Record<(typeof BOOLEAN_FIELDS)[number], boolean>> =
		{};
	for (const key of BOOLEAN_FIELDS) {
		if (typeof v[key] !== "boolean") return null;
		booleans[key] = v[key] as boolean;
	}
	if (!Array.isArray(v.tags) || v.tags.length > LIMITS.tags) return null;
	const tags: PreviewProject["tags"] = [];
	for (const tag of v.tags) {
		if (!isRecord(tag)) return null;
		const id = text(tag.id, LIMITS.tagText);
		const tagText = text(tag.text, LIMITS.tagText);
		if (id === null || tagText === null) return null;
		tags.push({ id, text: tagText });
	}
	return {
		...(booleans as Pick<PreviewProject, (typeof BOOLEAN_FIELDS)[number]>),
		conversation_ask_for_participant_name_label: nameLabel,
		default_conversation_description: description,
		default_conversation_finish_text: finish,
		default_conversation_title: title,
		default_conversation_tutorial_slug: tutorial,
		language,
		legal_basis: legal,
		organiser_name: organiser,
		privacy_policy_url: policy,
		tags,
	};
}

function parseTopics(v: unknown): PreviewTopic[] | null {
	if (!Array.isArray(v) || v.length > LIMITS.topics) return null;
	const out: PreviewTopic[] = [];
	for (const topic of v) {
		if (!isRecord(topic)) return null;
		const key = text(topic.key, LIMITS.label);
		const label = text(topic.label, LIMITS.title);
		if (!key || label === null) return null;
		out.push({ key, label });
	}
	return out;
}

function parseResult(v: unknown): PreviewResult | null | undefined {
	if (v === null) return null;
	if (!isRecord(v)) return undefined;
	const source = oneOf(v.source, ["example", "model"] as const);
	const key = text(v.key, LIMITS.label);
	const body = text(v.text, LIMITS.longText);
	if (!source || !key || body === null) return undefined;
	return { key, source, text: body };
}

/** The message, when it is a well-formed preview message; null for anything else. */
export function parsePreviewMessage(data: unknown): PreviewMessage | null {
	if (!isRecord(data)) return null;
	if (data.type !== PREVIEW_MESSAGE || data.version !== PREVIEW_VERSION)
		return null;
	const screen = oneOf(data.screen, PREVIEW_SCREENS);
	const project = parseProject(data.project);
	const topics = parseTopics(data.topics);
	const explore = parseResult(data.explore);
	const verify = parseResult(data.verify);
	const highlight =
		data.highlight === null ? null : oneOf(data.highlight, PREVIEW_HIGHLIGHTS);
	if (!screen || !project || !topics) return null;
	if (explore === undefined || verify === undefined) return null;
	if (data.highlight !== null && highlight === null) return null;
	if (!Number.isSafeInteger(data.reset) || (data.reset as number) < 0)
		return null;
	return {
		explore,
		highlight,
		project,
		reset: data.reset as number,
		screen,
		topics,
		type: PREVIEW_MESSAGE,
		verify,
		version: PREVIEW_VERSION,
	};
}

export function isReadyMessage(data: unknown): boolean {
	return isRecord(data) && data.type === PREVIEW_READY;
}

/** The origin of a configured base URL ("https://portal.dembrane.com"), or null. */
export function originOf(url: string): string | null {
	try {
		const origin = new URL(url).origin;
		return origin === "null" ? null : origin;
	} catch {
		return null;
	}
}
