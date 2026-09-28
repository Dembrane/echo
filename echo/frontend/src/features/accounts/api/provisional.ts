import { z } from "zod4";
import {
	AccountStage,
	Language,
	OfferItem,
	OfferTemplate,
	type RouteSpec,
} from "../contract/contract.gen";

/**
 * PROVISIONAL: the demo flow and the tasks summary, typed here until the backend's
 * contract commit adds them to platform/packages/accounts/src/contract.ts. Everything the
 * UI assumes about those routes is in this one file; when the contract lands, delete the
 * matching entries here, move the names in routes.ts to the contract's, and fix what tsc
 * reports. Nothing outside src/features/accounts and the Help entry imports it.
 */

export const DemoStepKey = z.enum([
	"website",
	"research",
	"corpus",
	"seeding",
	"extraction",
	"draft",
]);
export const DemoStepStatus = z.enum(["pending", "running", "done", "failed"]);

export const DemoStep = z.object({
	/** What went wrong, shown under a failed step. */
	error: z.string().nullable(),
	finished_at: z.string().nullable(),
	key: DemoStepKey,
	started_at: z.string().nullable(),
	status: DemoStepStatus,
});

export const Demo = z.object({
	contact_email: z.string(),
	email_code_sign_in: z.boolean(),
	id: z.string(),
	/** Set when publishing sent the sign-in invitation. */
	invitation_sent_at: z.string().nullable(),
	org_id: z.string(),
	organisation_name: z.string(),
	/** The project in the dashboard, once seeded. */
	project_url: z.string().nullable(),
	/** The public presentation, once the draft is ready. */
	public_url: z.string().nullable(),
	published_at: z.string().nullable(),
	status: z.enum(["running", "failed", "draft_ready", "published"]),
	steps: z.array(DemoStep),
});

export const StartDemoRequest = z.object({
	brief: z.string().trim().min(1).max(8000),
	contact_email: z.email().max(255),
	contact_name: z
		.string()
		.trim()
		.max(255)
		.nullish()
		.transform((v) => v || null),
	/** Publishing sends the contact a sign-in invitation with an email code. */
	email_code_sign_in: z.boolean().default(false),
	/** An event or customer example to model the demo on. */
	example: z
		.string()
		.trim()
		.max(8000)
		.nullish()
		.transform((v) => v || null),
	language: Language,
	offer: z
		.object({
			items: z.array(OfferItem).min(1).max(50),
			language: Language,
			template: OfferTemplate,
		})
		.nullish()
		.transform((v) => v ?? null),
	organisation_name: z.string().trim().min(1).max(255),
	website_url: z.url().max(2000),
});

export const RetryDemoRequest = z.object({ step: DemoStepKey });

export const TasksSummary = z.object({
	orgs: z.array(
		z.object({
			done: z.number().int(),
			id: z.string(),
			logo_url: z.string().nullable(),
			name: z.string(),
			next_task_title: z.string().nullable(),
			stage: AccountStage.nullable(),
			total: z.number().int(),
		}),
	),
});

export type DemoT = z.output<typeof Demo>;
export type DemoStepT = z.output<typeof DemoStep>;
export type TasksSummaryT = z.output<typeof TasksSummary>;

const D = "/api/v2/admin/popcorn/demos";

export const PROVISIONAL_ROUTES = {
	publishDemo: {
		method: "POST",
		path: `${D}/:demoId/publish`,
		permission: "staff:workspaces",
		response: Demo,
	},
	readDemo: {
		method: "GET",
		path: `${D}/:demoId`,
		permission: "staff:workspaces",
		response: Demo,
	},
	retryDemo: {
		method: "POST",
		path: `${D}/:demoId/retry`,
		permission: "staff:workspaces",
		request: RetryDemoRequest,
		response: Demo,
	},
	startDemo: {
		method: "POST",
		path: D,
		permission: "staff:workspaces",
		request: StartDemoRequest,
		response: Demo,
		status: 201,
	},
	tasksSummary: {
		method: "GET",
		path: "/api/v2/account/tasks-summary",
		permission: "signed-in",
		response: TasksSummary,
	},
} as const satisfies Record<string, RouteSpec>;
