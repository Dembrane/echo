import { t } from "@lingui/core/macro";
import { useCallback, useEffect, useRef, useState } from "react";
import { type DigestSurface, track } from "@/lib/analytics/events";
import type { DigestMaterial } from "./DigestEntry/DigestEntry";
import type { FileState } from "./DigestProgress/DigestProgress";
import {
	charsBucket,
	type DigestFailure,
	type DigestRequestBody,
	type DigestResult,
	type DigestSourceBody,
	durationBucket,
	failureCause,
	fieldsReturned,
	isUseful,
	requestDigest,
} from "./digest";

export type { DigestSurface };
export type RunPhase = "idle" | "files" | "material" | "done" | "failed";

export interface RunOutcome {
	result: DigestResult | null;
	cause: DigestFailure | null;
	/** Everything read, files and pasted text, for the fallback. */
	text: string;
}

const linkName = (url: string) => {
	try {
		const u = new URL(url);
		return `${u.hostname}${u.pathname === "/" ? "" : u.pathname}`.slice(0, 120);
	} catch {
		return url.slice(0, 120);
	}
};

const isAbort = (err: unknown) =>
	(err instanceof DOMException && err.name === "AbortError") ||
	(err instanceof Error && err.name === "AbortError");

/**
 * One digest run, as both entries use it: read the files here (the extract chunk loads
 * on the first drop), send only their text with the pasted text and the link, and report
 * how it went. Analytics carry counts, kinds and buckets, never names, text or terms.
 */
export function useDigestRun(o: {
	workspaceId: string | null;
	language: string;
	surface: DigestSurface;
}) {
	const [phase, setPhase] = useState<RunPhase>("idle");
	const [files, setFiles] = useState<FileState[]>([]);
	const controller = useRef<AbortController | null>(null);
	useEffect(() => () => controller.current?.abort(), []);

	const cancel = useCallback(() => {
		controller.current?.abort();
		controller.current = null;
		setPhase("idle");
		setFiles([]);
	}, []);

	const reset = useCallback(() => {
		setPhase("idle");
		setFiles([]);
	}, []);

	const run = useCallback(
		async (
			m: DigestMaterial,
			existing?: DigestRequestBody["existing"],
		): Promise<RunOutcome | null> => {
			controller.current?.abort();
			const c = new AbortController();
			controller.current = c;
			const fail = (cause: DigestFailure, text: string): RunOutcome => {
				track("project_digest_failed", { cause, surface: o.surface });
				setPhase("failed");
				return { cause, result: null, text };
			};
			setFiles(m.files.map((f) => ({ name: f.name, state: "waiting" })));
			setPhase(m.files.length ? "files" : "material");
			const sources: DigestSourceBody[] = [];
			try {
				if (m.files.length) {
					const { extractFiles } = await import("./extract");
					const read = await extractFiles(m.files, {
						alreadyChars: m.text.length,
						onProgress: (i, s) =>
							setFiles((prev) =>
								prev.map((f, j) => {
									if (j !== i) return f;
									if (s === "reading")
										return { name: f.name, state: "reading" };
									return s.status === "ok"
										? {
												chars: s.chars,
												cut: s.cut,
												name: f.name,
												state: "done",
											}
										: { name: f.name, reason: s.reason, state: "refused" };
								}),
							),
						signal: c.signal,
					});
					for (const r of read)
						if (r.status === "ok")
							sources.push({ kind: "file", name: r.name, text: r.text });
				}
			} catch (err) {
				if (isAbort(err) || c.signal.aborted) return null;
				return fail("error", "");
			}
			if (m.text)
				sources.push({ kind: "text", name: t`Pasted text`, text: m.text });
			if (m.url)
				sources.push({ kind: "url", name: linkName(m.url), url: m.url });
			const text = sources
				.filter((s) => s.text)
				.map((s) => s.text)
				.join("\n\n");
			if (!sources.length) return fail("no_readable_files", "");

			const chars = sources.reduce((n, s) => n + (s.text?.length ?? 0), 0);
			track("project_digest_started", {
				kinds: [...new Set(sources.map((s) => s.kind))],
				sources: sources.length,
				surface: o.surface,
				total_chars_bucket: charsBucket(chars),
			});
			setPhase("material");
			const started = Date.now();
			try {
				if (!o.workspaceId) throw new Error("No workspace selected");
				const result = await requestDigest(
					o.workspaceId,
					{ existing: existing ?? null, language: o.language, sources },
					c.signal,
				);
				if (c.signal.aborted) return null;
				if (
					o.surface === "picker"
						? !isUseful(result)
						: !fieldsReturned(result).length
				)
					return fail("nothing_found", text);
				track("project_digest_ready", {
					duration_ms_bucket: durationBucket(Date.now() - started),
					fields_returned: fieldsReturned(result).length,
					surface: o.surface,
					template_key: result.template?.key ?? null,
				});
				setPhase("done");
				return { cause: null, result, text };
			} catch (err) {
				if (isAbort(err) || c.signal.aborted) return null;
				return fail(failureCause(err), text);
			}
		},
		[o.language, o.surface, o.workspaceId],
	);

	return { cancel, files, phase, reset, run };
}
