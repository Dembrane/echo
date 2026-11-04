import { api } from "@/lib/api";

/** The write the upgrade prompt makes when someone continues to the website.
 *
 *   POST /api/v2/pricing-configurations
 *
 * The `api` client already carries `/api` as its base. The endpoint is an
 * upsert on `config_session_id` and takes the email from the session, so the
 * row knows the account without the website ever being told who it is. The
 * website sends `config_session_id` back as its handover and echo links its
 * own row to this one.
 */
export const PRICING_CONFIGURATION_PATH = "/v2/pricing-configurations";

/** Rows saved by the handover, told apart from the old configurator's. */
export const HANDOVER_SET_VERSION = "handover-1";

export type HandoverPayload = {
	config_session_id: string;
	locale: string;
	wall_key: string;
	workspace_id?: string;
	org_id?: string;
	project_id?: string;
};

export const saveHandover = (row: HandoverPayload) =>
	api.post<unknown, { reference: string }>(PRICING_CONFIGURATION_PATH, {
		...row,
		answers_raw: {},
		config: { handover: true },
		mount: "app",
		question_set_version: HANDOVER_SET_VERSION,
		status: "in_progress",
	});

export type VoiceAttachment = {
	/** Which free text box the audio belongs to. */
	question_key: string;
	blob: Blob;
	duration_ms: number;
};
