/**
 * The portal editor's pages (ECHO-1060), in the order a participant meets them. The editor,
 * its sidebar menu and the breadcrumbs all read this one list; it imports nothing, so the
 * sidebar takes no more of the editor than this.
 */
export const SECTION_KEYS = [
	"welcome",
	"privacy",
	"about",
	"explore",
	"verify",
	"finish",
] as const;

export type SectionKey = (typeof SECTION_KEYS)[number];

export const isSectionKey = (value: string | undefined): value is SectionKey =>
	!!value && (SECTION_KEYS as readonly string[]).includes(value);
