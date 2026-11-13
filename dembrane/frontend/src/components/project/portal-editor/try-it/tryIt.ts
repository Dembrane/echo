import { postJson } from "@/lib/apiJson";
import type { PreviewResult } from "@/lib/portalPreview/protocol";
import type { PortalFormValues } from "../portalForm";

/**
 * "Try it" in the portal editor (ECHO-1061): the host's Explore or Verify settings as they
 * are now, saved or not, run on dembrane's sample conversation. The server
 * (platform/packages/verify/src/try-it) runs the live prompts and stores nothing; the
 * dashboard calls it and hands the text to the preview frame in the message's `result`.
 * The frame itself still sends nothing.
 */

export type TrySection = "explore" | "verify";

/**
 * What a try runs on. Only the built-in sample today; the host's own conversations (the
 * only way to show "look at other conversations") would be a second source here and on
 * the server's TrySource.
 */
export type TrySource = "sample";

export interface TryRequestBody {
	kind: TrySection;
	language: string;
	source: TrySource;
	get_reply_mode?: string | null;
	get_reply_prompt?: string | null;
	topic_key?: string | null;
}

export interface TryResponse {
	kind: TrySection;
	key: string;
	text: string;
	source: TrySource;
	language: string;
}

export const requestTry = (
	projectId: string,
	body: TryRequestBody,
	signal?: AbortSignal,
): Promise<TryResponse> =>
	postJson(`/v2/projects/${projectId}/portal-editor/try`, body, signal);

/**
 * The request for a page's settings now, or null when there is nothing to try (Verify with
 * no topic chosen). Verify tries the first chosen topic, the one the preview shows.
 */
export function tryRequest(
	section: TrySection,
	values: Pick<
		PortalFormValues,
		"language" | "get_reply_mode" | "get_reply_prompt" | "verification_topics"
	>,
): TryRequestBody | null {
	if (section === "explore")
		return {
			get_reply_mode: values.get_reply_mode,
			// The prompt counts only in custom mode, as on the server.
			get_reply_prompt:
				values.get_reply_mode === "custom" ? values.get_reply_prompt : null,
			kind: "explore",
			language: values.language,
			source: "sample",
		};
	const topic = values.verification_topics?.[0];
	if (!topic) return null;
	return {
		kind: "verify",
		language: values.language,
		source: "sample",
		topic_key: topic,
	};
}

/** Two requests run the same settings: a result for one is current for the other. */
export const sameSettings = (
	a: TryRequestBody | null,
	b: TryRequestBody | null,
) => JSON.stringify(a) === JSON.stringify(b);

/** The result as the preview shows it, in place of the hand-written example. */
export const previewResultOf = (r: TryResponse): PreviewResult => ({
	key: r.key,
	source: "model",
	text: r.text,
});
