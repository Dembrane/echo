import { cardScene } from "../scenes/card-scene.ts";
import type { Release } from "./release.ts";

// dembrane 3: faster, more stable, accessible. Numbers in square brackets are
// placeholders; the render warns while any are left.

export const v3: Release = {
	version: "v3.0.0",
	whatsNew: [
		cardScene({
			about: "Title",
			card: {
				en: {
					headline: "What's new in dembrane 3",
					kicker: "Release v3.0.0",
					kind: "title",
					sub: "Faster, more stable, and easier to use for everyone.",
				},
				nl: {
					headline: "Nieuw in dembrane 3",
					kicker: "Release v3.0.0",
					kind: "title",
					sub: "Sneller, stabieler en voor iedereen makkelijker te gebruiken.",
				},
			},
			id: "v3-title",
			say: [
				{
					en: "dembrane 3 is faster, more stable, and easier to use for everyone.",
					nl: "dembrane 3 is sneller, stabieler en voor iedereen makkelijker te gebruiken.",
				},
			],
			since: "v3.0.0",
		}),
		cardScene({
			about: "Faster",
			card: {
				en: {
					headline: "Faster",
					kind: "stats",
					note: "Measured on [where and how; fill in].",
					stats: [
						{ label: "to open a project", value: "[x]s" },
						{ label: "from recording to transcript", value: "[x] min" },
					],
				},
				nl: {
					headline: "Sneller",
					kind: "stats",
					note: "Gemeten op [waar en hoe; invullen].",
					stats: [
						{ label: "om een project te openen", value: "[x]s" },
						{ label: "van opname tot transcript", value: "[x] min" },
					],
				},
			},
			id: "v3-faster",
			say: [
				{
					en: "Projects open faster, and transcripts are ready sooner after a recording ends.",
					nl: "Projecten openen sneller en transcripten zijn eerder klaar na een opname.",
				},
			],
			since: "v3.0.0",
		}),
		cardScene({
			about: "More stable",
			card: {
				en: {
					headline: "More stable",
					kind: "stats",
					note: "Compared with v2.4, over [period; fill in].",
					stats: [
						{ label: "uptime", value: "[x]%" },
						{ label: "fewer failed uploads", value: "[x]%" },
					],
				},
				nl: {
					headline: "Stabieler",
					kind: "stats",
					note: "Vergeleken met v2.4, over [periode; invullen].",
					stats: [
						{ label: "beschikbaarheid", value: "[x]%" },
						{ label: "minder mislukte uploads", value: "[x]%" },
					],
				},
			},
			id: "v3-stable",
			say: [
				{
					en: "A new backend means fewer interruptions, and recordings that arrive reliably.",
					nl: "Een nieuwe backend betekent minder onderbrekingen, en opnames die betrouwbaar binnenkomen.",
				},
			],
			since: "v3.0.0",
		}),
		"keyboard",
		"best-practices",
		cardScene({
			about: "Closing",
			card: {
				en: {
					headline: "Try it now",
					kind: "title",
					sub: "Everything in this video is live for your account today.",
				},
				nl: {
					headline: "Probeer het nu",
					kind: "title",
					sub: "Alles in deze video staat vandaag voor je klaar.",
				},
			},
			id: "v3-close",
			say: [
				{
					en: "All of this is live for your account today.",
					nl: "Dit staat vandaag allemaal voor je klaar.",
				},
			],
			since: "v3.0.0",
		}),
	],
};
