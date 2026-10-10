import type { Scene } from "../lib/scene.ts";
import * as app from "../scenes/app.ts";
import * as cards from "../scenes/cards.ts";

export interface Release {
	version: string;
	/**
	 * The what's new video, in order: scenes made for this release (number cards and
	 * the like), and ids of onboarding scenes, which are reused as recorded there.
	 */
	whatsNew: (Scene | string)[];
}

/** The onboarding video, in order: a new user's first walk through dembrane. */
export const ONBOARDING: Scene[] = [
	cards.welcome,
	app.home,
	app.bestPractices,
	app.createProject,
	app.share,
	app.portal,
	app.conversations,
	app.ask,
	app.report,
	app.keyboard,
	cards.nextSteps,
];

export function whatsNewScenes(release: Release): Scene[] {
	return release.whatsNew.map((s) => {
		if (typeof s !== "string") return s;
		const found = ONBOARDING.find((o) => o.id === s);
		if (!found)
			throw new Error(`${release.version}: no onboarding scene "${s}"`);
		return found;
	});
}
