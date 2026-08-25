import axios from "axios";
import { api } from "@/lib/api";
import type { Answers, PricingConfig } from "./configuratorState";

/** The write that turns an attempt into a row, and the row into a reference.
 *
 * The endpoint writes the `pricing_configuration` collection:
 *
 *   POST /api/v2/pricing-configurations
 *
 * The `api` client already carries `/api` as its base, so the call below reads
 * `/v2/pricing-configurations`. `/api/v2` is where the server mounts its v2
 * router today, and plural nouns are its convention (`/orgs`, `/workspaces`).
 *
 * It is an upsert on `config_session_id`. Sending twice updates one row, which
 * is what makes a retry safe and what lets every step write before it
 * advances.
 */

export type VoiceAttachment = {
	/** Which free text box the audio belongs to. */
	question_key: string;
	blob: Blob;
	duration_ms: number;
};

export type PricingConfigurationPayload = {
	config_session_id: string;
	question_set_version: string;
	config_shape_version: number;
	/** `app` in v1. `site` when the website version lands. */
	mount: "app" | "site";
	locale: string;
	/** Which wall started this session. Comes from the gate. */
	wall_key?: string;
	workspace_id?: string;
	org_id?: string;
	project_id?: string;
	/** Exactly what was sent, so a question set change never breaks an old
	 * row. */
	answers_raw: Answers;
	/** The shaped object that rides on every event. */
	config: PricingConfig;
	/** `in_progress` on a step write, `submitted` on the send. */
	status: "in_progress" | "submitted";
	/** Audio that failed to transcribe twice. It travels with the answers rather
	 * than being lost. Absent on almost every send. */
	voice_audio?: VoiceAttachment[];
};

export type PricingConfigurationResult = {
	/** The short code on the booking and on the confirmation screen, DEM-XXXX. */
	reference: string;
};

export const PRICING_CONFIGURATION_PATH = "/v2/pricing-configurations";

/** Why a send failed. */
export type SubmitFailure = {
	reason: "http_4xx" | "http_500" | "network" | "timeout";
	/** 0 when there was no response at all. */
	status: number;
};

export const submitFailureOf = (error: unknown): SubmitFailure => {
	if (!axios.isAxiosError(error)) return { reason: "network", status: 0 };
	if (error.code === "ECONNABORTED") return { reason: "timeout", status: 0 };
	const status = error.response?.status;
	if (status === undefined) return { reason: "network", status: 0 };
	if (status >= 500) return { reason: "http_500", status };
	return { reason: "http_4xx", status };
};

/** Send the configuration and get the reference back.
 *
 * JSON when there is no audio, which is the normal case. Multipart when a
 * transcription failed twice and the recording has to travel with the answers:
 * the JSON goes in a `payload` field and each recording beside it.
 */
export const submitConfiguration = async (
	payload: PricingConfigurationPayload,
): Promise<PricingConfigurationResult> => {
	const attachments = payload.voice_audio ?? [];
	if (attachments.length === 0) {
		const { voice_audio: _unused, ...body } = payload;
		return api.post<unknown, PricingConfigurationResult>(
			PRICING_CONFIGURATION_PATH,
			body,
		);
	}

	const { voice_audio: _audio, ...body } = payload;
	const form = new FormData();
	form.append("payload", JSON.stringify(body));
	for (const attachment of attachments) {
		form.append(
			`audio_${attachment.question_key}`,
			attachment.blob,
			`${attachment.question_key}.webm`,
		);
		form.append(
			`audio_${attachment.question_key}_duration_ms`,
			String(attachment.duration_ms),
		);
	}
	return api.post<unknown, PricingConfigurationResult>(
		PRICING_CONFIGURATION_PATH,
		form,
	);
};

export type SubmitConfiguration = typeof submitConfiguration;
