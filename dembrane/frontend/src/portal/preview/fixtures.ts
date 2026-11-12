import type { QueryClient } from "@tanstack/react-query";
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
			return `${conversation}/explore`;
		case "verify-topics":
			return `${base}/choose/verify`;
		case "verify-summary":
			return `${conversation}/verify/approve?artifact_id=${PREVIEW_ARTIFACT_ID}`;
		case "finish":
			return `${conversation}/finish`;
	}
}

/**
 * Puts a message's values where the participant screens read them: the queries they
 * already use, keyed as they key them. Nothing is fetched; a screen that asks for more
 * gets nothing (see lockDown).
 */
export function seedPreview(
	client: QueryClient,
	projectId: string,
	message: PreviewMessage,
): void {
	const { project, topics, result } = message;
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
		content: result?.text ?? "",
		date_created: new Date().toISOString(),
		id: PREVIEW_ARTIFACT_ID,
		// A key outside the chosen topics would send the screen back; none skips that check.
		key: topics.some((t) => t.key === result?.key) ? (result?.key ?? "") : "",
		read_aloud_stream_url: "",
	});
}
