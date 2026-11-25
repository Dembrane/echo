// The responses of the AI provider routes for the screenshots, written by the real service against
// a seeded database (accounts with a month of use in the call log, Google enabled for analysis
// only, for both jobs, and a project that has chosen nothing), as of 25 Nov 2026 12:00 UTC.
import type {
	OrgAiProviders,
	ProjectAiProviders,
} from "@/components/ai-provider/hooks";
import type { StaffAiProviders } from "@/features/accounts/staff/AiProviderSection";

export const orgScaleway = {
	available: ["scaleway", "google"],
	cost: {
		analysis: {
			google: {
				billing: "on_top",
				job: "analysis",
				monthly_eur: 3.91,
				per_100_calls_eur: null,
				per_hour_eur: null,
				provider: "google",
			},
			scaleway: {
				billing: "included",
				job: "analysis",
				monthly_eur: 2.72,
				per_100_calls_eur: null,
				per_hour_eur: null,
				provider: "scaleway",
			},
		},
		transcription: {
			google: {
				billing: "on_top",
				job: "transcription",
				monthly_eur: 11.76,
				per_100_calls_eur: null,
				per_hour_eur: null,
				provider: "google",
			},
			scaleway: {
				billing: "included",
				job: "transcription",
				monthly_eur: 2.52,
				per_100_calls_eur: null,
				per_hour_eur: null,
				provider: "scaleway",
			},
		},
	},
	defaults: {
		analysis: "scaleway",
		transcription: "scaleway",
	},
	enabled: {
		analysis: ["scaleway"],
		transcription: ["scaleway"],
	},
	environment_default: "scaleway",
	history: [],
	jobs: ["transcription", "analysis"],
	models: {
		scaleway: {
			analysis: ["glm-5.3"],
			transcription: ["whisper-large-v3"],
		},
	},
	month: {
		from: "2026-11-01T00:00:00.000Z",
		spent: {
			google: 0,
			scaleway: 4.5,
		},
	},
	serves: {
		google: ["transcription", "analysis"],
		scaleway: ["transcription", "analysis"],
	},
} as unknown as OrgAiProviders;

export const orgGoogleForAnalysis = {
	available: ["scaleway", "google"],
	cost: {
		analysis: {
			google: {
				billing: "on_top",
				job: "analysis",
				monthly_eur: 3.91,
				per_100_calls_eur: null,
				per_hour_eur: null,
				provider: "google",
			},
			scaleway: {
				billing: "included",
				job: "analysis",
				monthly_eur: 2.72,
				per_100_calls_eur: null,
				per_hour_eur: null,
				provider: "scaleway",
			},
		},
		transcription: {
			google: {
				billing: "on_top",
				job: "transcription",
				monthly_eur: 11.76,
				per_100_calls_eur: null,
				per_hour_eur: null,
				provider: "google",
			},
			scaleway: {
				billing: "included",
				job: "transcription",
				monthly_eur: 2.52,
				per_100_calls_eur: null,
				per_hour_eur: null,
				provider: "scaleway",
			},
		},
	},
	defaults: {
		analysis: "scaleway",
		transcription: "scaleway",
	},
	enabled: {
		analysis: ["scaleway", "google"],
		transcription: ["scaleway"],
	},
	environment_default: "scaleway",
	history: [
		{
			at: "2026-11-15T12:00:00.000Z",
			job: "analysis",
			kind: "enabled",
			provider: "google",
			request_at: "2026-11-13T12:00:00.000Z",
		},
	],
	jobs: ["transcription", "analysis"],
	models: {
		scaleway: {
			analysis: ["glm-5.3"],
			transcription: ["whisper-large-v3"],
		},
	},
	month: {
		from: "2026-11-01T00:00:00.000Z",
		spent: {
			google: 1.13,
			scaleway: 3.71,
		},
	},
	serves: {
		google: ["transcription", "analysis"],
		scaleway: ["transcription", "analysis"],
	},
} as unknown as OrgAiProviders;

export const projectChoices = {
	can_change: true,
	cost: {
		analysis: {
			google: {
				billing: "on_top",
				job: "analysis",
				monthly_eur: 3.91,
				per_100_calls_eur: null,
				per_hour_eur: null,
				provider: "google",
			},
			scaleway: {
				billing: "included",
				job: "analysis",
				monthly_eur: 2.72,
				per_100_calls_eur: null,
				per_hour_eur: null,
				provider: "scaleway",
			},
		},
		transcription: {
			google: {
				billing: "on_top",
				job: "transcription",
				monthly_eur: 11.76,
				per_100_calls_eur: null,
				per_hour_eur: null,
				provider: "google",
			},
			scaleway: {
				billing: "included",
				job: "transcription",
				monthly_eur: 2.52,
				per_100_calls_eur: null,
				per_hour_eur: null,
				provider: "scaleway",
			},
		},
	},
	jobs: {
		analysis: {
			account_default: "scaleway",
			current: null,
			effective: "scaleway",
			options: ["scaleway", "google"],
		},
		transcription: {
			account_default: "scaleway",
			current: null,
			effective: "scaleway",
			options: ["scaleway", "google"],
		},
	},
	models: {
		scaleway: {
			analysis: ["glm-5.3"],
			transcription: ["whisper-large-v3"],
		},
	},
} as unknown as ProjectAiProviders;

export const staffAccount = {
	available: ["scaleway", "google"],
	cost: {
		analysis: {
			google: {
				billing: "on_top",
				job: "analysis",
				monthly_eur: 3.91,
				per_100_calls_eur: null,
				per_hour_eur: null,
				provider: "google",
			},
			scaleway: {
				billing: "included",
				job: "analysis",
				monthly_eur: 2.72,
				per_100_calls_eur: null,
				per_hour_eur: null,
				provider: "scaleway",
			},
		},
		transcription: {
			google: {
				billing: "on_top",
				job: "transcription",
				monthly_eur: 11.76,
				per_100_calls_eur: null,
				per_hour_eur: null,
				provider: "google",
			},
			scaleway: {
				billing: "included",
				job: "transcription",
				monthly_eur: 2.52,
				per_100_calls_eur: null,
				per_hour_eur: null,
				provider: "scaleway",
			},
		},
	},
	defaults: {
		analysis: "google",
		transcription: "scaleway",
	},
	enabled: {
		analysis: ["scaleway", "google"],
		transcription: ["scaleway", "google"],
	},
	environment_default: "scaleway",
	history: [
		{
			at: "2026-11-22T12:00:00.000Z",
			by: "Sam Example",
			job: "analysis",
			kind: "default",
			provider: "google",
			request_at: "2026-11-13T12:00:00.000Z",
		},
		{
			at: "2026-11-21T12:00:00.000Z",
			by: "Sam Example",
			job: "analysis",
			kind: "default",
			provider: "scaleway",
			request_at: "2026-11-13T12:00:00.000Z",
		},
		{
			at: "2026-11-19T12:00:00.000Z",
			by: "Sam Example",
			job: "analysis",
			kind: "default",
			provider: "google",
			request_at: "2026-11-13T12:00:00.000Z",
		},
		{
			at: "2026-11-17T12:00:00.000Z",
			by: "Sam Example",
			job: "transcription",
			kind: "enabled",
			provider: "google",
			request_at: "2026-11-13T12:00:00.000Z",
		},
		{
			at: "2026-11-15T12:00:00.000Z",
			by: "Sam Example",
			job: "analysis",
			kind: "enabled",
			provider: "google",
			request_at: "2026-11-13T12:00:00.000Z",
		},
	],
	jobs: ["transcription", "analysis"],
	models: {
		scaleway: {
			analysis: ["glm-5.3"],
			transcription: ["whisper-large-v3"],
		},
	},
	month: {
		from: "2026-11-01T00:00:00.000Z",
		spent: {
			google: 1.13,
			scaleway: 3.71,
		},
	},
	serves: {
		google: ["transcription", "analysis"],
		scaleway: ["transcription", "analysis"],
	},
	tickets: [
		{
			created_at: "2026-11-13T12:00:00.000Z",
			id: "9ec56219-f003-4054-af53-4dd035a0f2c8",
			subject: "Google Vertex AI for Analysis",
		},
	],
} as unknown as StaffAiProviders;
