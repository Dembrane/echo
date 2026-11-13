import type {
	PreviewHighlight,
	PreviewScreen,
} from "@/lib/portalPreview/protocol";
import type { PortalFormValues } from "./portalForm";
import { SECTION_KEYS, type SectionKey } from "./sectionKeys";

/** What decides whether an option applies, beyond the page's own values. */
export interface OptionFlags {
	/** Asking for email shows (ENABLE_PARTICIPANT_EMAIL, or the project has it on). */
	showAskForEmail: boolean;
	/** Report notifications show (the same flag, or the project has them on). */
	showReportNotifications: boolean;
}

export interface OptionDef {
	key: string;
	/** The participant screen the option changes. */
	screen: PreviewScreen;
	/** The part of that screen it changes, outlined in the preview. */
	highlight: PreviewHighlight | null;
	/** Absent: always. A conditional option is listed only while this holds. */
	applies?: (values: PortalFormValues, flags: OptionFlags) => boolean;
}

export interface SectionDef {
	options: readonly OptionDef[];
	/** The screens the preview can show for this page, the first by default. */
	screens: readonly PreviewScreen[];
}

const exploreOn = (v: PortalFormValues) => v.is_get_reply_enabled;
const verifyOn = (v: PortalFormValues) => v.is_verify_enabled;

/**
 * The portal editor's pages and their options, in order (ECHO-1060), as the product owner
 * set them: Welcome, Privacy, About, Explore, Verify, Finish.
 */
export const SECTIONS: Record<SectionKey, SectionDef> = {
	about: {
		options: [
			{ highlight: "name", key: "ask-name", screen: "form" },
			{
				applies: (v) => v.default_conversation_ask_for_participant_name,
				highlight: "name",
				key: "name-label",
				screen: "form",
			},
			{ highlight: "tags", key: "tags", screen: "form" },
			{ highlight: null, key: "auto-titles", screen: "form" },
			{
				applies: (v) => v.enable_ai_title_and_tags,
				highlight: null,
				key: "title-prompt",
				screen: "form",
			},
			{
				applies: (_v, f) => f.showAskForEmail,
				highlight: "notifications",
				key: "ask-email",
				screen: "finish",
			},
		],
		screens: ["form", "finish"],
	},
	explore: {
		options: [
			{ highlight: null, key: "enabled", screen: "recording" },
			{
				applies: exploreOn,
				highlight: "explore",
				key: "mode",
				screen: "explore",
			},
			{
				applies: (v) => exploreOn(v) && v.get_reply_mode === "custom",
				highlight: "explore",
				key: "prompt",
				screen: "explore",
			},
			{
				applies: exploreOn,
				highlight: "explore",
				key: "other-conversations",
				screen: "explore",
			},
		],
		screens: ["explore", "recording"],
	},
	finish: {
		options: [
			{ highlight: "finish-text", key: "text", screen: "finish" },
			{
				applies: (_v, f) => f.showReportNotifications,
				highlight: "notifications",
				key: "notifications",
				screen: "finish",
			},
			{ highlight: "event-cta", key: "event", screen: "finish" },
		],
		screens: ["finish"],
	},
	privacy: {
		options: [
			{ highlight: "privacy", key: "legal-basis", screen: "privacy" },
			{ highlight: null, key: "anonymise", screen: "recording" },
		],
		screens: ["privacy", "recording"],
	},
	verify: {
		options: [
			{ highlight: null, key: "enabled", screen: "recording" },
			{
				applies: verifyOn,
				highlight: "verify-topics",
				key: "topics",
				screen: "verify-topics",
			},
			{
				applies: verifyOn,
				highlight: "verify-topics",
				key: "custom-topics",
				screen: "verify-topics",
			},
			{
				applies: verifyOn,
				highlight: null,
				key: "remind",
				screen: "recording",
			},
			{
				applies: verifyOn,
				highlight: "verify-summary",
				key: "key-terms",
				screen: "verify-summary",
			},
		],
		screens: ["verify-topics", "verify-summary", "recording"],
	},
	welcome: {
		options: [
			{ highlight: null, key: "language", screen: "landing" },
			{ highlight: "title", key: "title", screen: "recording" },
			{ highlight: "description", key: "description", screen: "recording" },
			{ highlight: "tutorial", key: "tutorial", screen: "tutorial" },
		],
		screens: ["landing", "tutorial", "recording"],
	},
};

/** The options that apply now, in order. */
export const applicableOptions = (
	section: SectionKey,
	values: PortalFormValues,
	flags: OptionFlags,
): OptionDef[] =>
	SECTIONS[section].options.filter(
		(o) => !o.applies || o.applies(values, flags),
	);

/** The option the address names when it applies, else the first. */
export const resolveOption = (
	section: SectionKey,
	key: string | undefined,
	values: PortalFormValues,
	flags: OptionFlags,
): OptionDef => {
	const options = applicableOptions(section, values, flags);
	return options.find((o) => o.key === key) ?? options[0];
};

/** The page after this one, or null after Finish. */
export const nextSection = (section: SectionKey): SectionKey | null =>
	SECTION_KEYS[SECTION_KEYS.indexOf(section) + 1] ?? null;
