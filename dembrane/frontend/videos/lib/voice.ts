import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { join, parse } from "node:path";

// A narrator's own recordings, cleaned up and cut into lines. Raw takes live outside the
// repo, one per scene and language: <voice dir>/<lang>/<scene id>.<m4a|wav|mp3|...>, the
// scene's lines read in order with a pause between them. A file named <scene id>-<n> replaces
// line n alone, for a retake.
//
// Or one file for the whole script, <voice dir>/<lang>/all.<ext>: every scene in script order,
// with a pause of about 3 s between scenes and about 1.5 s between lines. Scene files and
// retakes still replace their part of it.
//
// Clean-up is DeepFilterNet 3 (speech enhancement: removes room noise and hum, keeps the
// voice), then a high-pass and EBU R128 loudness normalisation. Nothing is synthesised.

const AUDIO = /\.(wav|m4a|mp3|aac|flac|ogg|opus|webm|aiff?|caf)$/i;
const LUFS = -16;

const DEEP_FILTER = {
	sha256: {
		"aarch64-apple-darwin":
			"4601e7f4e4c03e59a4c5b5000216ef3add3e808799cfccd95e14e83ea4611081",
		"aarch64-unknown-linux-gnu":
			"14e02a1c0028f3ca0bdf83b62b3336e56ba0556894ef295a95e8573f06557166",
		"x86_64-apple-darwin":
			"d3be84003acb7c23e738ad7f70a158ec779a8d233a82e7fa3e717d112eb5b50f",
		"x86_64-unknown-linux-musl":
			"70775e251eee44c0f2451a1e833326cf8bcbbe304d3e7cd12851e6fce72ef7da",
	} as Record<string, string>,
	version: "0.5.6",
};

export interface Line {
	file: string;
	seconds: number;
	/** What was said, when the lines were transcribed. */
	text?: string;
}

/** The deep-filter binary: $VIDEO_DEEP_FILTER, or a pinned release downloaded once. */
function deepFilter(binDir: string): string {
	if (process.env.VIDEO_DEEP_FILTER) return process.env.VIDEO_DEEP_FILTER;
	const targets: Record<string, string> = {
		"darwin-arm64": "aarch64-apple-darwin",
		"darwin-x64": "x86_64-apple-darwin",
		"linux-arm64": "aarch64-unknown-linux-gnu",
		"linux-x64": "x86_64-unknown-linux-musl",
	};
	const target = targets[`${process.platform}-${process.arch}`];
	if (!target)
		throw new Error(
			"no DeepFilterNet build for this machine: set VIDEO_DEEP_FILTER to a deep-filter binary",
		);
	const bin = join(binDir, `deep-filter-${DEEP_FILTER.version}`);
	if (!existsSync(bin)) {
		mkdirSync(binDir, { recursive: true });
		execFileSync("curl", [
			"-sSLf",
			"-o",
			bin,
			`https://github.com/Rikorose/DeepFilterNet/releases/download/v${DEEP_FILTER.version}/deep-filter-${DEEP_FILTER.version}-${target}`,
		]);
		const sum = createHash("sha256").update(readFileSync(bin)).digest("hex");
		if (sum !== DEEP_FILTER.sha256[target]) {
			rmSync(bin);
			throw new Error(`deep-filter download for ${target} failed its checksum`);
		}
		chmodSync(bin, 0o755);
	}
	return bin;
}

const ff = (args: string[]) =>
	execFileSync("ffmpeg", ["-y", "-hide_banner", "-nostats", ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
/** Runs ffmpeg for its analysis (loudnorm, silencedetect), which it writes to stderr. */
function ffLog(args: string[]): string {
	const r = spawnSync("ffmpeg", ["-hide_banner", "-nostats", ...args], {
		encoding: "utf8",
	});
	if (r.status !== 0) throw new Error(r.stderr);
	return r.stderr;
}

function seconds(file: string): number {
	return Number(
		execFileSync(
			"ffprobe",
			[
				"-v",
				"error",
				"-show_entries",
				"format=duration",
				"-of",
				"csv=p=0",
				file,
			],
			{ encoding: "utf8" },
		),
	);
}

/** Raw take -> 48 kHz mono -> DeepFilterNet -> high-pass and loudness. */
function clean(raw: string, out: string, work: string, bin: string) {
	rmSync(work, { force: true, recursive: true });
	mkdirSync(join(work, "df"), { recursive: true });
	const mono = join(work, "take.wav");
	ff(["-i", raw, "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", mono]);
	// -a 40 keeps a little of the room under the voice, which sounds less processed than
	// removing all of it. -D lines the output up with the input.
	execFileSync(bin, ["-D", "-a", "40", "-o", join(work, "df"), mono], {
		stdio: "ignore",
	});
	const filtered = join(work, "df", "take.wav");
	const pre = "highpass=f=80";
	const measured = ffLog([
		"-i",
		filtered,
		"-af",
		`${pre},loudnorm=I=${LUFS}:TP=-1.5:LRA=11:print_format=json`,
		"-f",
		"null",
		"-",
	]);
	const m = JSON.parse(measured.slice(measured.lastIndexOf("{")));
	ff([
		"-i",
		filtered,
		"-af",
		`${pre},loudnorm=I=${LUFS}:TP=-1.5:LRA=11:linear=true:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset},aresample=48000`,
		"-c:a",
		"pcm_s16le",
		out,
	]);
	rmSync(work, { force: true, recursive: true });
}

/** Pauses in a cleaned take as [start, end] seconds, from ffmpeg's silencedetect. */
function pauses(file: string): [number, number][] {
	const log = ffLog([
		"-i",
		file,
		"-af",
		"silencedetect=noise=-42dB:d=0.25",
		"-f",
		"null",
		"-",
	]);
	const quiet: [number, number][] = [];
	for (const m of log.matchAll(
		/silence_start: ([\d.]+)[\s\S]*?silence_end: ([\d.]+)/g,
	))
		quiet.push([Number(m[1]), Number(m[2])]);
	const tail = log.match(/silence_start: ([\d.]+)(?![\s\S]*silence_end)/);
	if (tail) quiet.push([Number(tail[1]), seconds(file)]);
	return quiet;
}

/** A pause this long or longer, in a whole-script take, is a break between scenes. */
const SCENE_BREAK = 2;

const clock = (t: number) =>
	`${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

/**
 * Splits a whole-script take into one stretch per scene, at its `scenes - 1` longest pauses.
 * Throws, naming the times, when the long pauses don't match the scene count.
 */
function splitScenes(file: string, scenes: string[]): [number, number][] {
	const total = seconds(file);
	const long = pauses(file)
		.filter(([s, e]) => s > 0.05 && e < total - 0.05)
		.filter(([s, e]) => e - s >= SCENE_BREAK);
	if (long.length !== scenes.length - 1)
		throw new Error(
			`${file}: the script has ${scenes.length} scenes, so it needs ${scenes.length - 1} pauses of ${SCENE_BREAK} s or more, but has ${long.length}${long.length ? ` (at ${long.map(([s]) => clock(s)).join(", ")})` : ""}. Leave about 3 s between scenes and less than ${SCENE_BREAK} s inside a scene.`,
		);
	const edges = [0, ...long.flatMap(([s, e]) => [s + 0.1, e - 0.1]), total];
	const parts: [number, number][] = [];
	for (let i = 0; i < edges.length; i += 2)
		parts.push([edges[i], edges[i + 1]]);
	return parts;
}

/** Spoken stretches of a cleaned take, split at its longest pauses into `lines` parts. */
function split(file: string, lines: number | undefined): [number, number][] {
	const total = seconds(file);
	const quiet = pauses(file);
	// Silence at the very start or end is trimmed, not a break.
	const first =
		quiet.length && quiet[0][0] < 0.05 ? (quiet.shift()?.[1] ?? 0) : 0;
	const last =
		quiet.length && (quiet.at(-1)?.[1] ?? 0) > total - 0.05
			? (quiet.pop()?.[0] ?? total)
			: total;
	// With the line count known, the n-1 longest pauses are the breaks; otherwise any pause
	// of 0.8 s or more is one.
	const breaks = (
		lines
			? [...quiet]
					.sort((a, b) => b[1] - b[0] - (a[1] - a[0]))
					.slice(0, lines - 1)
			: quiet.filter(([s, e]) => e - s >= 0.8)
	).sort((a, b) => a[0] - b[0]);
	if (lines && breaks.length < lines - 1)
		throw new Error(
			`${file}: expected ${lines} lines but found only ${breaks.length + 1}; leave a clear pause between lines`,
		);
	const edges = [first, ...breaks.flat(), last];
	const parts: [number, number][] = [];
	for (let i = 0; i < edges.length; i += 2)
		parts.push([
			Math.max(0, edges[i] - 0.06),
			Math.min(total, edges[i + 1] + 0.12),
		]);
	return parts;
}

function cut(file: string, [from, to]: [number, number], out: string) {
	const d = to - from;
	ff([
		"-ss",
		from.toFixed(3),
		"-t",
		d.toFixed(3),
		"-i",
		file,
		"-af",
		`afade=t=in:d=0.01,afade=t=out:st=${(d - 0.03).toFixed(3)}:d=0.03`,
		"-c:a",
		"pcm_s16le",
		out,
	]);
}

/**
 * Cleans and cuts the takes for one language. `lines` is how many lines each scene has
 * (from its last recording), which makes the cuts reliable. Returns "<scene id>-<n>" ->
 * line, for the scenes that have a take.
 */
export function prepareVoice(o: {
	voiceDir: string;
	lang: string;
	lines: Record<string, number | undefined>;
	outDir: string;
	binDir: string;
}): Map<string, Line> {
	const found = new Map<string, Line>();
	const dir = join(o.voiceDir, o.lang);
	if (!existsSync(dir)) return found;
	const takes = readdirSync(dir).filter((f) => AUDIO.test(f));
	if (takes.length === 0) return found;
	const bin = deepFilter(o.binDir);
	const out = join(o.outDir, o.lang);
	rmSync(out, { force: true, recursive: true });
	mkdirSync(out, { recursive: true });
	const work = join(out, ".work");
	const byName = new Map(takes.map((f) => [parse(f).name, f]));
	const all = byName.get("all");
	if (all) {
		const ids = Object.keys(o.lines);
		const missing = ids.filter((id) => !o.lines[id]);
		if (missing.length)
			throw new Error(
				`voiceover: record the video once before using ${o.lang}/${all}; no line count yet for ${missing.join(", ")}`,
			);
		const cleaned = join(out, "all.take.wav");
		clean(join(dir, all), cleaned, work, bin);
		splitScenes(cleaned, ids).forEach((scene, s) => {
			const id = ids[s];
			const part = join(out, `${id}.part.wav`);
			cut(cleaned, scene, part);
			let lines: [number, number][];
			try {
				lines = split(part, o.lines[id]);
			} catch {
				throw new Error(
					`voiceover: ${o.lang}/${all}, scene ${s + 1} (${id}, from ${clock(scene[0])}): expected ${o.lines[id]} lines with a pause between each`,
				);
			}
			lines.forEach((line, i) => {
				const file = join(out, `${id}-${i + 1}.wav`);
				cut(part, line, file);
				found.set(`${id}-${i + 1}`, { file, seconds: seconds(file) });
			});
		});
	}
	for (const [id, count] of Object.entries(o.lines)) {
		const take = byName.get(id);
		if (take) {
			const cleaned = join(out, `${id}.take.wav`);
			clean(join(dir, take), cleaned, work, bin);
			split(cleaned, count).forEach((part, i) => {
				const file = join(out, `${id}-${i + 1}.wav`);
				cut(cleaned, part, file);
				found.set(`${id}-${i + 1}`, { file, seconds: seconds(file) });
			});
		}
		// Retakes of single lines replace the cut from the scene's take.
		for (let n = 1; n <= (count ?? 20); n++) {
			const retake = byName.get(`${id}-${n}`);
			if (!retake) continue;
			const cleaned = join(out, `${id}-${n}.take.wav`);
			clean(join(dir, retake), cleaned, work, bin);
			const [part] = split(cleaned, 1);
			const file = join(out, `${id}-${n}.wav`);
			cut(cleaned, part, file);
			found.set(`${id}-${n}`, { file, seconds: seconds(file) });
		}
	}
	const known = new Set(
		Object.entries(o.lines).flatMap(([id, n]) => [
			id,
			...Array.from({ length: n ?? 20 }, (_, i) => `${id}-${i + 1}`),
		]),
	);
	known.add("all");
	for (const name of byName.keys())
		if (!known.has(name))
			console.warn(`voiceover: ${o.lang}/${byName.get(name)} matches no scene`);
	return found;
}

/** Words speech recognition tends to get wrong, written the way the brand writes them. */
const SPELLING: [RegExp, string][] = [
	[/\b(dembrane|dem brain|the membrane)\b/gi, "dembrane"],
];

/**
 * Sets each line's text to what the narrator said, using Whisper (faster-whisper, run by
 * lib/transcribe.py), so captions match ad libs. `prompts` are the scripted lines by key.
 */
export function transcribe(
	lines: Map<string, Line>,
	lang: string,
	prompts: Map<string, string>,
) {
	if (lines.size === 0) return;
	const keys = [...lines.keys()];
	const r = spawnSync(
		process.env.VIDEO_PYTHON ?? "python3",
		[join(import.meta.dirname, "transcribe.py")],
		{
			encoding: "utf8",
			input: JSON.stringify({
				lang,
				lines: keys.map((k) => ({
					file: lines.get(k)?.file,
					prompt: prompts.get(k) ?? "",
				})),
				model: process.env.VIDEO_WHISPER_MODEL ?? "large-v3-turbo",
			}),
			maxBuffer: 1 << 24,
			stdio: ["pipe", "pipe", "inherit"],
		},
	);
	if (r.status !== 0)
		throw new Error(
			"transcribing the voiceover failed; it needs Python with `pip install faster-whisper`",
		);
	const texts = JSON.parse(r.stdout) as string[];
	keys.forEach((k, i) => {
		const line = lines.get(k);
		if (!line || !texts[i]) return;
		line.text = SPELLING.reduce(
			(t, [from, to]) => t.replace(from, to),
			texts[i],
		);
	});
}
