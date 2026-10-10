import { cardScene } from "../scenes/card-scene.ts";
import type { Release } from "./release.ts";

// dembrane 3: faster, more stable, accessible. Numbers in square brackets are
// placeholders; the render warns while any are left.
//
// Accessible: e2e/grammar.spec.ts checks pages with axe against WCAG 2.1 A and AA, so the
// video says "tested against WCAG 2.1 AA", never "compliant" (that needs a full audit).
//
// Faster: pnpm videos:measure on 2026-10-10, production v2.4.2 against staging v3.0.2,
// 20 alternating runs each from one machine on an empty project, median times. Write-up in
// the project files, videos/v3/v2-v3-timings.md. No environment records time to transcript,
// so the card makes no claim about it.
// More stable: no numbers until v3 has run in production long enough to compare uptime and
// failed uploads with v2.

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
					sub: "Faster, more stable, and tested against WCAG 2.1 AA.",
				},
				nl: {
					headline: "Nieuw in dembrane 3",
					kicker: "Release v3.0.0",
					kind: "title",
					sub: "Sneller, stabieler en getest tegen WCAG 2.1 AA.",
				},
			},
			id: "v3-title",
			say: [
				{
					en: "dembrane 3 is faster, more stable, and tested against the WCAG 2.1 AA accessibility guidelines.",
					nl: "dembrane 3 is sneller, stabieler en getest tegen de toegankelijkheidsrichtlijnen WCAG 2.1 AA.",
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
					note: "Our test, October 2026: the same empty project opened 20 times on each version, from one machine.",
					stats: [
						{ label: "faster to open a project from your list", value: "36%" },
						{ label: "faster to load a project from a link", value: "27%" },
					],
				},
				nl: {
					headline: "Sneller",
					kind: "stats",
					note: "Onze test, oktober 2026: hetzelfde lege project 20 keer geopend in elke versie, vanaf één computer.",
					stats: [
						{
							label: "sneller een project openen vanuit je lijst",
							value: "36%",
						},
						{ label: "sneller een project laden via een link", value: "27%" },
					],
				},
			},
			id: "v3-faster",
			say: [
				{
					en: "In our tests, projects open about a third faster than in dembrane 2.",
					nl: "In onze tests openen projecten ongeveer een derde sneller dan in dembrane 2.",
				},
			],
			since: "v3.0.0",
		}),
		cardScene({
			about: "More stable",
			card: {
				en: {
					headline: "More stable",
					kind: "title",
					sub: "dembrane 3 runs on a new backend, rebuilt from the ground up.",
				},
				nl: {
					headline: "Stabieler",
					kind: "title",
					sub: "dembrane 3 draait op een nieuwe backend, helemaal opnieuw gebouwd.",
				},
			},
			id: "v3-stable",
			say: [
				{
					en: "dembrane 3 runs on a new backend, rebuilt from the ground up.",
					nl: "dembrane 3 draait op een nieuwe backend, helemaal opnieuw gebouwd.",
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
