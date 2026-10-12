import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CDPSession, Page } from "@playwright/test";

// Records a page through Chrome's screencast (CDP), which hands over a frame only when the
// page changes. Each frame is held until the next one, so the clip keeps real timing, and
// ffmpeg resamples it to a constant frame rate. Sharper than Playwright's recordVideo,
// which encodes at a fixed low bitrate.

export const FPS = 30;

export interface Recording {
	/** Seconds since the recording started; captions use the same clock. */
	now(): number;
	stop(outFile: string): Promise<number>;
}

export async function record(
	page: Page,
	opts: {
		/** The largest frame Chrome hands over. */
		width: number;
		height: number;
		workDir: string;
		/** ffmpeg filters that turn a frame into a 1920x1080 picture. */
		frame: string;
	},
): Promise<Recording> {
	rmSync(opts.workDir, { force: true, recursive: true });
	mkdirSync(opts.workDir, { recursive: true });
	const cdp: CDPSession = await page.context().newCDPSession(page);
	const frames: { file: string; t: number }[] = [];
	const started = performance.now();
	const now = () => (performance.now() - started) / 1000;
	cdp.on("Page.screencastFrame", (f) => {
		const file = join(
			opts.workDir,
			`${String(frames.length).padStart(6, "0")}.jpg`,
		);
		writeFileSync(file, Buffer.from(f.data, "base64"));
		frames.push({ file, t: now() });
		void cdp
			.send("Page.screencastFrameAck", { sessionId: f.sessionId })
			.catch(() => {});
	});
	await cdp.send("Page.startScreencast", {
		everyNthFrame: 1,
		format: "jpeg",
		maxHeight: opts.height,
		maxWidth: opts.width,
		quality: 92,
	});
	return {
		now,
		async stop(outFile) {
			const end = now();
			await cdp.send("Page.stopScreencast");
			await cdp.detach();
			if (frames.length === 0) throw new Error("screencast produced no frames");
			// The concat demuxer shows each image for its duration; the last line repeats the
			// final frame so its duration is honoured.
			const lines: string[] = [];
			frames.forEach((f, i) => {
				const next = frames[i + 1]?.t ?? end;
				lines.push(
					`file '${f.file}'`,
					`duration ${Math.max(next - f.t, 0.001).toFixed(4)}`,
				);
			});
			lines.push(`file '${frames[frames.length - 1].file}'`);
			const list = join(opts.workDir, "frames.txt");
			writeFileSync(list, lines.join("\n"));
			// The first frame arrives a moment after start; pad the front with it so the clip
			// and the caption clock agree.
			const lead = frames[0].t;
			execFileSync("ffmpeg", [
				"-y",
				"-loglevel",
				"error",
				"-f",
				"concat",
				"-safe",
				"0",
				"-i",
				list,
				"-vf",
				`tpad=start_duration=${lead.toFixed(3)}:start_mode=clone,${opts.frame},setsar=1,fps=${FPS},format=yuv420p`,
				"-c:v",
				"libx264",
				"-preset",
				"slow",
				"-crf",
				"16",
				outFile,
			]);
			rmSync(opts.workDir, { force: true, recursive: true });
			return end;
		},
	};
}
