// Records and assembles the release videos. See videos/README.md.
//
//   node videos/render.ts [--release v3.0.0] [--videos onboarding,whats-new] [--langs en,nl]
//                         [--only <scene id>,...] [--burn] [--no-seed] [--no-record]

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type Browser, type BrowserContext, chromium } from "@playwright/test";
import { record } from "./lib/capture.ts";
import { installCursor } from "./lib/cursor.ts";
import {
	type Ctx,
	type Cue,
	type Fixtures,
	LANGS,
	type Lang,
	readingSeconds,
	type Scene,
	vtt,
} from "./lib/scene.ts";
import {
	ONBOARDING,
	type Release,
	whatsNewScenes,
} from "./releases/release.ts";
import { v3 } from "./releases/v3.0.0.ts";

const RELEASES: Release[] = [v3];
const here = dirname(fileURLToPath(import.meta.url));
const PARCHMENT = "0xF6F4F1";

const { values: args } = parseArgs({
	allowNegative: true,
	options: {
		burn: { default: false, type: "boolean" },
		dashboard: {
			default: process.env.VIDEO_DASHBOARD_URL ?? "http://localhost:5173",
			type: "string",
		},
		fixtures: { default: join(here, "out", "fixtures.json"), type: "string" },
		langs: { default: "en,nl", type: "string" },
		only: { type: "string" },
		portal: {
			default: process.env.VIDEO_PORTAL_URL ?? "http://localhost:5174",
			type: "string",
		},
		record: { default: true, type: "boolean" },
		release: { default: RELEASES[RELEASES.length - 1].version, type: "string" },
		seed: { default: true, type: "boolean" },
		videos: { default: "onboarding,whats-new", type: "string" },
	},
});

const release = RELEASES.find((r) => r.version === args.release);
if (!release) throw new Error(`no release ${args.release} in videos/releases`);
const langs = args.langs.split(",") as Lang[];
const videos = args.videos.split(",") as ("onboarding" | "whats-new")[];
const email = process.env.VIDEO_EMAIL ?? "alex@example.org";
const password = process.env.VIDEO_PASSWORD ?? "video-recording-only";
const outDir = join(here, "out", release.version);

/**
 * Seeds the local database (apps/migrate/src/video-seed.ts) and keeps the ids it prints.
 * It also removes what the last recording made, so each language starts from the same screens.
 */
function seed() {
	const printed = execFileSync(
		"bun",
		["--env-file=.env.local", "apps/migrate/src/video-seed.ts"],
		{
			cwd: join(here, "../../platform"),
			encoding: "utf8",
		},
	);
	mkdirSync(dirname(args.fixtures), { recursive: true });
	writeFileSync(args.fixtures, printed);
}
if (args.seed && args.record) seed();
if (!existsSync(args.fixtures))
	throw new Error(
		`${args.fixtures} is missing: run without --no-seed, or write the ids there`,
	);
// The seed prints {login, sample}; a hand-written file may hold the ids directly.
const seeded = JSON.parse(readFileSync(args.fixtures, "utf8"));
const fixtures: Fixtures = seeded.sample ?? seeded;

const playlists: Record<string, Scene[]> = {
	onboarding: ONBOARDING,
	"whats-new": whatsNewScenes(release),
};

// The local env badge under the logo is not part of the product.
const HIDE_DEV = `
	(() => {
		const css = "span.pointer-events-none.whitespace-nowrap.text-xs.leading-none { display: none !important; }";
		const add = () => { if (!document.head) return requestAnimationFrame(add); const s = document.createElement("style"); s.textContent = css; document.head.appendChild(s); };
		add();
	})();
`;

async function signIn(): Promise<string> {
	const context = await (await browserAt(1.5)).newContext({
		viewport: { height: 720, width: 1280 },
	});
	const page = await context.newPage();
	await page.goto(`${args.dashboard}/en-US/login`);
	await page.locator('input[type="email"]').first().fill(email);
	await page.locator('input[type="password"]').first().fill(password);
	await page.locator('button[type="submit"]').first().click();
	// One session per account: take over any earlier one (a previous run's).
	const anyway = page.getByRole("button", { name: /log in anyway/i });
	await anyway.or(page.locator("nav")).first().waitFor();
	if (await anyway.isVisible()) await anyway.click();
	await page.waitForURL(/\/o\b/);
	// Dismiss the release popup once; the server remembers it.
	await page.waitForTimeout(2500);
	await page.keyboard.press("Escape");
	await page.waitForTimeout(500);
	const state = join(outDir, "session.json");
	await context.storageState({ path: state });
	await context.close();
	return state;
}

// Chrome's screencast hands over frames at the browser's device scale, which only the
// --force-device-scale-factor switch (in the new headless mode) sets, not a context's
// deviceScaleFactor. So there is one browser per scale: 1.5 turns the 1280x720 desktop into
// 1920x1080 frames, 2 renders the phone sharp.
const browsers = new Map<number, Promise<Browser>>();
function browserAt(scale: number): Promise<Browser> {
	let b = browsers.get(scale);
	if (!b) {
		b = chromium.launch({
			args: ["--headless=new", `--force-device-scale-factor=${scale}`],
			executablePath:
				process.env.VIDEO_CHROMIUM ??
				(existsSync("/opt/pw-browsers/chromium")
					? "/opt/pw-browsers/chromium"
					: undefined),
			headless: false,
		});
		browsers.set(scale, b);
	}
	return b;
}

async function newContext(
	scene: Scene,
	state: string,
	lang: Lang,
): Promise<BrowserContext> {
	const phone = scene.device === "phone";
	const browser = await browserAt(phone ? 2 : 1.5);
	const context = await browser.newContext({
		deviceScaleFactor: phone ? 2 : 1.5,
		locale: LANGS[lang],
		reducedMotion: "no-preference",
		storageState: phone ? undefined : state,
		viewport: phone
			? { height: 844, width: 390 }
			: { height: 720, width: 1280 },
		...(phone && { hasTouch: true, isMobile: true }),
	});
	await context.addInitScript(HIDE_DEV);
	return context;
}

/** Records one scene in one language: <out>/<lang>/clips/<id>.mp4 and its captions. */
async function recordScene(
	scene: Scene,
	state: string,
	lang: Lang,
	shared: Record<string, string>,
) {
	const dir = join(outDir, lang, "clips");
	mkdirSync(dir, { recursive: true });
	const context = await newContext(scene, state, lang);
	const page = await context.newPage();
	await installCursor(page);
	const cues: Cue[] = [];
	let clock = () => 0;
	const ctx: Ctx = {
		fixtures,
		lang,
		page,
		portalUrl: (path) => `${args.portal}/${LANGS[lang]}${path}`,
		async say(text, action) {
			const start = clock();
			await action?.();
			const left = readingSeconds(text[lang]) - (clock() - start);
			if (left > 0) await page.waitForTimeout(left * 1000);
			cues.push({ end: clock(), start, text: text[lang] });
		},
		shared,
		url: (path) => `${args.dashboard}/${LANGS[lang]}${path}`,
	};
	await scene.setup?.(ctx);
	await page.waitForTimeout(800);
	const phone = scene.device === "phone";
	const z = scene.zoom;
	const rec = await record(page, {
		frame: phone
			? `scale=-2:960:flags=lanczos,pad=iw+12:ih+12:6:6:color=0x2D2D2C,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=${PARCHMENT}`
			: `${z ? `crop=${z.width}:${Math.round((z.width * 9) / 16)}:${z.x}:${z.y},` : ""}scale=1920:1080:flags=lanczos`,
		height: phone ? 1688 : 1080,
		width: phone ? 780 : 1920,
		workDir: join(dir, `${scene.id}.frames`),
	});
	clock = rec.now;
	await page.waitForTimeout(300);
	await scene.run(ctx);
	await page.waitForTimeout(500);
	const duration = await rec.stop(join(dir, `${scene.id}.mp4`));
	writeFileSync(
		join(dir, `${scene.id}.json`),
		JSON.stringify({ cues, duration }, null, "\t"),
	);
	await context.close();
	console.log(
		`  ${lang} ${scene.id}: ${duration.toFixed(1)} s, ${cues.length} captions`,
	);
}

/** Joins clips with a short fade through the parchment ground; writes the video and its captions. */
function assemble(name: string, scenes: Scene[], lang: Lang) {
	const dir = join(outDir, lang, "clips");
	const fade = 0.3;
	const inputs: string[] = [];
	const filters: string[] = [];
	const cues: Cue[] = [];
	let offset = 0;
	scenes.forEach((scene, i) => {
		const { cues: own, duration } = JSON.parse(
			readFileSync(join(dir, `${scene.id}.json`), "utf8"),
		) as { cues: Cue[]; duration: number };
		inputs.push("-i", join(dir, `${scene.id}.mp4`));
		filters.push(
			`[${i}:v]fade=t=in:st=0:d=${fade}:color=${PARCHMENT},fade=t=out:st=${(duration - fade).toFixed(3)}:d=${fade}:color=${PARCHMENT},setsar=1,setpts=PTS-STARTPTS[v${i}]`,
		);
		for (const c of own)
			cues.push({ end: c.end + offset, start: c.start + offset, text: c.text });
		offset += duration;
	});
	const base = join(outDir, `${name}.${lang}`);
	execFileSync("ffmpeg", [
		"-y",
		"-loglevel",
		"error",
		...inputs,
		"-filter_complex",
		`${filters.join(";")};${scenes.map((_, i) => `[v${i}]`).join("")}concat=n=${scenes.length}:v=1:a=0[out]`,
		"-map",
		"[out]",
		"-c:v",
		"libx264",
		"-preset",
		"slow",
		"-crf",
		"18",
		"-pix_fmt",
		"yuv420p",
		"-movflags",
		"+faststart",
		`${base}.mp4`,
	]);
	writeFileSync(`${base}.vtt`, vtt(cues));
	if (args.burn) burn(base);
	console.log(`${base}.mp4 (${offset.toFixed(0)} s)`);
}

/** A copy with the captions drawn in, for places that cannot load a caption file. */
function burn(base: string) {
	const fonts = join(here, "out", "fonts");
	const ttf = join(fonts, "DMSans.ttf");
	if (!existsSync(ttf)) {
		mkdirSync(fonts, { recursive: true });
		// libass reads TrueType, not the app's woff2.
		execFileSync("python3", [
			"-c",
			`from fontTools.ttLib import TTFont; f = TTFont("${join(here, "../src/fonts/dm-sans-variable.woff2")}"); f.flavor = None; f.save("${ttf}")`,
		]);
	}
	const style =
		"FontName=DM Sans,FontSize=13,PrimaryColour=&H00F1F4F6,OutlineColour=&H002C2D2D,BorderStyle=3,Outline=7,Shadow=0,MarginV=24";
	execFileSync("ffmpeg", [
		"-y",
		"-loglevel",
		"error",
		"-i",
		`${base}.mp4`,
		"-vf",
		`subtitles=${base}.vtt:fontsdir=${fonts}:force_style='${style}'`,
		"-c:v",
		"libx264",
		"-preset",
		"slow",
		"-crf",
		"18",
		"-pix_fmt",
		"yuv420p",
		"-movflags",
		"+faststart",
		`${base}.captioned.mp4`,
	]);
}

function warnPlaceholders(scenes: Scene[]) {
	const text = JSON.stringify(release?.whatsNew);
	const left = text.match(/\[[^\]]*(x|fill in|invullen)[^\]]*\]/g);
	if (left && scenes.length)
		console.warn(
			`placeholders left in ${release?.version}: ${[...new Set(left)].join(", ")}`,
		);
}

mkdirSync(outDir, { recursive: true });
try {
	const state = args.record ? await signIn() : "";
	const only = args.only?.split(",");
	const scenes = [
		...new Map(
			videos.flatMap((v) => playlists[v]).map((s) => [s.id, s]),
		).values(),
	];
	for (const [i, lang] of langs.entries()) {
		if (args.seed && args.record && i > 0) seed();
		const shared: Record<string, string> = {};
		for (const scene of scenes) {
			if (!args.record || (only && !only.includes(scene.id))) continue;
			await recordScene(scene, state, lang, shared);
		}
		if (only) continue;
		for (const v of videos) assemble(v, playlists[v], lang);
	}
	warnPlaceholders(playlists["whats-new"]);
} finally {
	for (const b of browsers.values()) await (await b).close();
}
