import { i18n } from "@lingui/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { durationBucket } from "@/components/project/digest/digest";
import { track } from "@/lib/analytics/events";
import { requestFailure } from "@/lib/apiJson";
import { loadErrorMessages } from "@/lib/errors/present";
import {
	requestTry,
	sameSettings,
	type TryRequestBody,
	type TryResponse,
	type TrySection,
} from "./tryIt";

export type TryStatus = "idle" | "running" | "result" | "limit" | "failed";

export interface TryState {
	status: TryStatus;
	/** The last result, kept while a new try runs or fails. */
	result: TryResponse | null;
	/** The result was made with other settings than the page has now. */
	stale: boolean;
	/** The error of a failed try, for its message. */
	error: unknown;
}

interface Options {
	projectId: string;
	section: TrySection;
	/** The request for the page's settings now; null when there is nothing to try. */
	request: TryRequestBody | null;
	/**
	 * The Explore mode or Verify topic as analytics may name it: a built-in key, or
	 * "custom" for a host's own topic, whose key is made from its label.
	 */
	eventKey: string;
	/** The request function; the server's by default. */
	send?: typeof requestTry;
}

/**
 * One page's "Try it" (ECHO-1061): runs the settings now, keeps the result, and says when
 * the settings have changed since. A result from earlier settings stays shown and is
 * marked as such, rather than cleared: a host tuning a prompt compares the new wording
 * with the last answer, and each try counts against the hourly limit.
 */
export function useTryIt({
	projectId,
	section,
	request,
	eventKey,
	send = requestTry,
}: Options) {
	const [state, setState] = useState<
		Omit<TryState, "stale"> & { ranWith: TryRequestBody | null }
	>({ error: null, ranWith: null, result: null, status: "idle" });
	const running = useRef<AbortController | null>(null);

	useEffect(() => () => running.current?.abort(), []);

	const run = useCallback(async () => {
		if (!request) return;
		running.current?.abort();
		const c = new AbortController();
		running.current = c;
		const key = eventKey;
		track("portal_editor_try_started", {
			key,
			project_id: projectId,
			section,
			source: request.source,
		});
		setState((s) => ({ ...s, error: null, status: "running" }));
		const started = Date.now();
		const finished = (outcome: "result" | "limit" | "failed", cause?: string) =>
			track("portal_editor_try_finished", {
				cause: cause ?? null,
				duration_ms_bucket: durationBucket(Date.now() - started),
				key,
				outcome,
				project_id: projectId,
				section,
				source: request.source,
			});
		try {
			const result = await send(projectId, request, c.signal);
			if (c.signal.aborted) return;
			setState({ error: null, ranWith: request, result, status: "result" });
			finished("result");
		} catch (error) {
			if (c.signal.aborted) return;
			// The failed line shows the error's own message: load the table first.
			await loadErrorMessages(i18n).catch(() => undefined);
			if (c.signal.aborted) return;
			const cause = requestFailure(error);
			const status = cause === "rate_limited" ? "limit" : "failed";
			setState((s) => ({ ...s, error, status }));
			finished(status, cause);
		}
	}, [projectId, request, section, send, eventKey]);

	const { ranWith, ...shown } = state;
	const stale = shown.result !== null && !sameSettings(ranWith, request);
	return { ...shown, run, stale };
}
