import type { QueryClient } from "@tanstack/react-query";
import type { AxiosAdapter, InternalAxiosRequestConfig } from "axios";
import { api, apiNoAuth } from "@/lib/api";
import type {
	PreviewMessage,
	PreviewScreen,
} from "@/lib/portalPreview/protocol";

/** The made-up conversation and draft every preview screen reads. */
export const PREVIEW_CONVERSATION_ID = "preview";
export const PREVIEW_ARTIFACT_ID = "preview-draft";

const LOCALES: Record<string, string> = {
	cs: "cs-CZ",
	de: "de-DE",
	en: "en-US",
	es: "es-ES",
	fr: "fr-FR",
	it: "it-IT",
	nl: "nl-NL",
	uk: "uk-UA",
};

export const previewLocale = (language: string) => LOCALES[language] ?? "en-US";

/** Where a screen opens inside the preview's own router. */
export function previewEntry(
	screen: PreviewScreen,
	language: string,
	projectId: string,
): string {
	const base = `/${previewLocale(language)}/${projectId}`;
	const conversation = `${base}/conversation/${PREVIEW_CONVERSATION_ID}`;
	switch (screen) {
		case "landing":
		case "tutorial":
			return `${base}/start`;
		case "privacy":
			return `${base}/start/privacy`;
		case "form":
			return `${base}/start/form`;
		case "recording":
			return conversation;
		case "explore":
			return `${conversation}?echo=1`;
		case "verify-topics":
			return `${conversation}/verify`;
		case "verify-summary":
			return `${conversation}/verify/approve?artifact_id=${PREVIEW_ARTIFACT_ID}`;
		case "finish":
			return `${conversation}/finish`;
	}
}

/**
 * Puts a message's values where the participant screens read them: the queries they
 * already use, keyed as they key them. Nothing is fetched: what a screen asks the API for
 * is answered from these (answerRequests), and anything else is refused.
 */
export function seedPreview(
	client: QueryClient,
	projectId: string,
	message: PreviewMessage,
): void {
	const { project, topics, verify } = message;
	const locale = previewLocale(project.language);
	const participantProject = {
		...project,
		conversation_limit_seconds: null,
		id: projectId,
		is_ai_available: true,
		is_taking_recordings: true,
		selected_verification_key_list: topics.map((t) => t.key).join(","),
		whitelabel_logo_url: null,
	};
	client.setQueryData(["participantProject", projectId], participantProject);
	client.setQueryData(
		["participant", "conversation", projectId, PREVIEW_CONVERSATION_ID],
		{
			id: PREVIEW_CONVERSATION_ID,
			is_anonymized: project.anonymize_transcripts,
			project_id: projectId,
		},
	);
	client.setQueryData(
		["participant", "conversation_chunks", PREVIEW_CONVERSATION_ID],
		[],
	);
	client.setQueryData(
		["participant", "conversation_replies", PREVIEW_CONVERSATION_ID],
		[],
	);
	client.setQueryData(
		["verify", "conversation_artifacts", PREVIEW_CONVERSATION_ID],
		[],
	);
	client.setQueryData(["verify", "topics", projectId], {
		available_topics: topics.map((t) => ({
			is_custom: false,
			key: t.key,
			translations: { [locale]: { label: t.label } },
		})),
		selected_topics: topics.map((t) => t.key),
	});
	client.setQueryData(["verify", "artifact_by_id", PREVIEW_ARTIFACT_ID], {
		approved_at: null,
		content: verify?.text ?? "",
		date_created: new Date().toISOString(),
		id: PREVIEW_ARTIFACT_ID,
		// A key outside the chosen topics would send the screen back; none skips that check.
		key: topics.some((t) => t.key === verify?.key) ? (verify?.key ?? "") : "",
		read_aloud_stream_url: "",
	});
}

const refused = () => new TypeError("The portal preview sends nothing.");

/** An answer the portal's own request gets inside the preview, or undefined: refused. */
export function previewAnswer(
	client: QueryClient,
	projectId: string,
	method: string,
	path: string,
	body: Record<string, unknown>,
): unknown {
	const read = (key: unknown[]) => client.getQueryData(key);
	const draft = read(["verify", "artifact_by_id", PREVIEW_ARTIFACT_ID]) as
		| Record<string, unknown>
		| undefined;
	const project = `/participant/projects/${projectId}`;
	const conversation = `${project}/conversations/${PREVIEW_CONVERSATION_ID}`;
	if (method === "get") {
		const reads: Record<string, unknown[]> = {
			[project]: ["participantProject", projectId],
			[conversation]: [
				"participant",
				"conversation",
				projectId,
				PREVIEW_CONVERSATION_ID,
			],
			[`${conversation}/chunks`]: [
				"participant",
				"conversation_chunks",
				PREVIEW_CONVERSATION_ID,
			],
			[`${conversation}/replies`]: [
				"participant",
				"conversation_replies",
				PREVIEW_CONVERSATION_ID,
			],
			[`/verify/topics/${projectId}`]: ["verify", "topics", projectId],
			[`/verify/artifacts/${PREVIEW_CONVERSATION_ID}`]: [
				"verify",
				"conversation_artifacts",
				PREVIEW_CONVERSATION_ID,
			],
			[`/verify/artifact/${PREVIEW_ARTIFACT_ID}`]: [
				"verify",
				"artifact_by_id",
				PREVIEW_ARTIFACT_ID,
			],
		};
		return reads[path] ? read(reads[path]) : undefined;
	}
	// Continue on the start form: the made-up conversation every screen reads.
	if (method === "post" && path === `${project}/conversations/initiate`)
		return read([
			"participant",
			"conversation",
			projectId,
			PREVIEW_CONVERSATION_ID,
		]);
	// A Verify draft for the chosen topic: the dashboard's example or tried result.
	if (method === "post" && path === "/verify/generate" && draft) {
		const topics = body.topic_list;
		const key = Array.isArray(topics) ? String(topics[0] ?? "") : "";
		return { artifact_list: [{ ...draft, key }] };
	}
	// Approving or revising the draft: it comes back as sent, saved nowhere.
	if (method === "put" && path === `/verify/artifact/${PREVIEW_ARTIFACT_ID}`)
		return draft && { ...draft, approved_at: body.approvedAt ?? null };
	// Asking for the report by email on the thank-you page.
	if (method === "post" && path === "/participant/report/subscribe") return {};
	return undefined;
}

/**
 * Answers the portal's own API requests from the preview's fixtures, inside the frame
 * (ECHO-1062): the API client gets an adapter that never sends, so the host can press
 * Continue, start a Verify draft and approve it, and nothing leaves the frame. A request
 * the fixtures do not answer is refused, as lockDown refuses every real one. Returns the
 * undo, for a test or an unmount.
 */
export function answerRequests(
	client: QueryClient,
	projectId: string,
): () => void {
	const answer: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
		const path = new URL(config.url ?? "", "https://preview.invalid").pathname;
		let body: Record<string, unknown> = {};
		try {
			body = typeof config.data === "string" ? JSON.parse(config.data) : {};
		} catch {
			// Not JSON: none of the answered requests.
		}
		const data = previewAnswer(
			client,
			projectId,
			(config.method ?? "get").toLowerCase(),
			path,
			body ?? {},
		);
		if (data === undefined) throw refused();
		return { config, data, headers: {}, status: 200, statusText: "OK" };
	};
	const refuse: AxiosAdapter = async () => {
		throw refused();
	};
	const before = [apiNoAuth.defaults.adapter, api.defaults.adapter] as const;
	apiNoAuth.defaults.adapter = answer;
	// The signed-in client has nothing to do in a participant screen.
	api.defaults.adapter = refuse;
	return () => {
		[apiNoAuth.defaults.adapter, api.defaults.adapter] = before;
	};
}
