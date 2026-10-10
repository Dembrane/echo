import type { Page } from "@playwright/test";

export const LANGS = { en: "en-US", nl: "nl-NL" } as const;
export type Lang = keyof typeof LANGS;
/** Every line a viewer reads or hears, in each video language. */
export type Text = Record<Lang, string>;

/** The ids of the seeded sample (apps/migrate/src/video-seed.ts prints them). */
export interface Fixtures {
	workspace_id: string;
	project_id: string;
	chat_id: string;
	report_id: string;
}

export interface Cue {
	start: number;
	end: number;
	text: string;
}

export interface Ctx {
	page: Page;
	lang: Lang;
	fixtures: Fixtures;
	/** A dashboard path in the video's language: url("/o") -> <dashboard>/nl-NL/o. */
	url(path: string): string;
	/** A participant portal path in the video's language. */
	portalUrl(path: string): string;
	/** Passed from scene to scene within one language, e.g. the project create-project made. */
	shared: Record<string, string>;
	/**
	 * Shows `text` as a caption while `action` runs, and holds the shot until the caption
	 * has been on screen long enough to read (or, with a voiceover, to be spoken).
	 */
	say(text: Text, action?: () => Promise<void>): Promise<void>;
}

export interface Scene {
	id: string;
	/** The release that introduced what the scene shows; a what's new video picks by it. */
	since: string;
	/** What the scene is about, for logs. */
	about: string;
	/** "phone" records the participant portal at phone size, framed on a plain ground. */
	device?: "desktop" | "phone";
	/** Records only this part of the 1920x1080 frame, enlarged: x, y and width, 16:9. */
	zoom?: { x: number; y: number; width: number };
	/** Runs before recording starts: open the first page so the clip never shows it loading. */
	setup?(ctx: Ctx): Promise<void>;
	run(ctx: Ctx): Promise<void>;
}

/**
 * Reading time for a caption: about 2.5 words a second (a relaxed pace for captions
 * people read while also watching the screen), plus a beat to find it, at least 2 s.
 */
export function readingSeconds(text: string): number {
	const words = text.trim().split(/\s+/).length;
	return Math.max(2, words / 2.5 + 0.6);
}

export function vtt(cues: Cue[]): string {
	const ts = (s: number) => {
		const ms = Math.round(s * 1000);
		const h = Math.floor(ms / 3_600_000);
		const m = Math.floor(ms / 60_000) % 60;
		const sec = Math.floor(ms / 1000) % 60;
		const pad = (n: number, w = 2) => String(n).padStart(w, "0");
		return `${pad(h)}:${pad(m)}:${pad(sec)}.${pad(ms % 1000, 3)}`;
	};
	return [
		"WEBVTT",
		"",
		...cues.flatMap((c, i) => [
			String(i + 1),
			`${ts(c.start)} --> ${ts(c.end)}`,
			c.text,
			"",
		]),
	].join("\n");
}
