import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

// Full-screen cards between app scenes (titles, numbers, short lists), drawn as HTML in
// the same browser so they share the app's font and the brand guide's rules
// (skills/brand-guidelines.md): parchment ground, graphite text, DM Sans at 300, sharp
// corners, left-aligned, institution blue for emphasis instead of bold.

const here = dirname(fileURLToPath(import.meta.url));
const asset = (rel: string, type: string) =>
	`data:${type};base64,${readFileSync(join(here, rel)).toString("base64")}`;
const FONT = asset("../../src/fonts/dm-sans-variable.woff2", "font/woff2");
const LOGO = asset(
	"../../../../brand/logos/dembrane-logo-minified.svg",
	"image/svg+xml",
);

export type Card =
	| { kind: "title"; kicker?: string; headline: string; sub?: string }
	| {
			kind: "stats";
			headline: string;
			stats: { value: string; label: string }[];
			note?: string;
	  }
	| { kind: "points"; headline: string; points: string[] };

const esc = (s: string) =>
	s.replace(
		/[&<>"]/g,
		(c) =>
			({ '"': "&quot;", "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string,
	);

function body(card: Card): string {
	switch (card.kind) {
		case "title":
			return `${card.kicker ? `<p class="kicker in">${esc(card.kicker)}</p>` : ""}
				<h1 class="in">${esc(card.headline)}</h1>
				${card.sub ? `<p class="sub in">${esc(card.sub)}</p>` : ""}`;
		case "stats":
			return `<h2 class="in">${esc(card.headline)}</h2>
				<div class="stats">${card.stats
					.map(
						(s) =>
							`<div class="stat in"><span class="value">${esc(s.value)}</span><span class="label">${esc(s.label)}</span></div>`,
					)
					.join("")}</div>
				${card.note ? `<p class="note in">${esc(card.note)}</p>` : ""}`;
		case "points":
			return `<h2 class="in">${esc(card.headline)}</h2>
				<ul>${card.points.map((p) => `<li class="in">${esc(p)}</li>`).join("")}</ul>`;
	}
}

export function cardHtml(card: Card): string {
	return `<!doctype html><html><head><meta charset="utf-8"><style>
		@font-face { font-family: "DM Sans"; src: url(${FONT}) format("woff2"); font-weight: 100 1000; }
		* { box-sizing: border-box; margin: 0; }
		html, body { height: 100%; }
		body { background: #f6f4f1; color: #2d2d2c; font-family: "DM Sans", sans-serif; font-weight: 300;
			font-feature-settings: "ss01", "ss02", "ss03", "ss04", "ss05", "ss06";
			display: flex; flex-direction: column; justify-content: center; padding: 0 120px; }
		.logo { position: fixed; left: 120px; bottom: 64px; height: 30px; }
		.bar { position: fixed; left: 0; top: 0; bottom: 0; width: 14px; background: linear-gradient(#00ffff, #1effa1, #f4ff81, #ffc2ff); }
		.kicker { font-size: 24px; font-weight: 500; color: #4169e1; margin-bottom: 20px; }
		h1 { font-size: 76px; font-weight: 300; line-height: 1.1; letter-spacing: -0.01em; max-width: 960px; }
		h2 { font-size: 48px; font-weight: 300; line-height: 1.15; margin-bottom: 48px; max-width: 960px; }
		.sub { font-size: 30px; margin-top: 28px; max-width: 860px; line-height: 1.35; }
		.stats { display: flex; gap: 80px; }
		.stat { display: flex; flex-direction: column; gap: 10px; border-top: 2px solid #4169e1; padding-top: 18px; min-width: 220px; }
		.value { font-size: 72px; font-weight: 400; color: #4169e1; }
		.label { font-size: 24px; max-width: 280px; line-height: 1.3; }
		.note { margin-top: 56px; font-size: 18px; color: #5c5c5a; max-width: 900px; }
		ul { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 22px; }
		li { font-size: 32px; padding-left: 36px; position: relative; max-width: 960px; line-height: 1.3; }
		li::before { content: ""; position: absolute; left: 0; top: 0.5em; width: 14px; height: 14px; background: #4169e1; }
		.in { opacity: 0; transform: translateY(14px); animation: in 600ms cubic-bezier(0.2, 0.7, 0.2, 1) forwards; }
		body:not(.play) .in { animation-play-state: paused; }
		@keyframes in { to { opacity: 1; transform: none; } }
	</style></head><body>
		<div class="bar"></div>
		${body(card)}
		<img class="logo" src="${LOGO}" alt="dembrane">
		<script>document.querySelectorAll(".in").forEach((el, i) => el.style.animationDelay = (150 + i * 220) + "ms");</script>
	</body></html>`;
}

/** Puts the card up with its entrance held, so recording can start on the empty ground. */
export async function showCard(page: Page, card: Card) {
	await page.setContent(cardHtml(card), { waitUntil: "load" });
	await page.evaluate(() => document.fonts.ready);
}

export async function playCard(page: Page) {
	await page.evaluate(() => document.body.classList.add("play"));
}
