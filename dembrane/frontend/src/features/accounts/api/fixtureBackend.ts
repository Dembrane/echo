import type { z } from "zod4";
import { API_BASE_URL } from "@/config";
import type {
	AccountCard,
	AccountListItem,
	BillingDetails,
	DemoStatusT,
	DocumentDetailT,
	DocumentFieldInput,
	DocumentSummaryT,
	RouteName,
	TaskT,
	TicketT,
	TimelineEvent,
} from "../contract/contract.gen";
import * as fx from "../contract/fixtures.gen";
import { AccountsApiError, type Params } from "./client";
import { pageCountOf, renderSigned, renderUnsigned } from "./fixturePdf";

/**
 * The accounts API answered in the page, for fixture mode. It starts from the Example Town
 * Council (sample) demo in fixtures.gen.ts and keeps one store per organisation, so the staff
 * card and the customer page see the same documents, tasks and questions, and every flow
 * (sign, unlock billing, push an offer, place fields, send) changes that store the way the
 * design says the backend does. Responses go through the contract schemas in client.ts.
 *
 * State lives in sessionStorage so a reload keeps it; `?fixtures=reset` starts over. Any
 * customer org id the dashboard routes to maps onto the demo store, which is what lets
 * the page run inside a real signed-in shell.
 */

type Out<S extends z.ZodType> = z.output<S>;
type Billing = Out<typeof BillingDetails>;
type Event = Out<typeof TimelineEvent>;
type FieldInput = z.input<typeof DocumentFieldInput>;

type StoredTask = TaskT;

interface Store {
	id: string;
	name: string;
	stage: "prospect" | "customer" | "churned" | null;
	created_at: string;
	docs: DocumentDetailT[];
	tasks: StoredTask[];
	tickets: TicketT[];
	billing: Billing;
	timeline: Event[];
	needs_form: Out<typeof AccountCard>["needs_form"];
	demo: unknown;
	members: Out<typeof AccountCard>["members"];
	needs_form_reference: string | null;
	/** Uploaded PDFs, base64. */
	uploads: Record<string, string>;
	/** Tasks given with a draft, created when it is sent. */
	pendingTasks: Record<string, { title: string; body: string | null }>;
	/** Signature images and confirmation texts, for stamping the signed PDF. */
	signatures: Record<string, { png: string; confirmation: string }>;
}

const KEY = "echo.accounts.fixtures.v2";
const DEMO = fx.accountPage.organisation.id;
const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const addDays = (iso: string, days: number) =>
	new Date(new Date(iso).getTime() + days * 86_400_000).toISOString();
const today = () => now().slice(0, 10);

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function demoStore(): Store {
	const offer = clone(fx.offerDetail);
	const dpa = clone(fx.signedDpaDetail);
	const invoiceSummary = fx.accountPage.documents.find(
		(d) => d.kind === "invoice",
	);
	const invoice: DocumentDetailT = {
		...(clone(invoiceSummary) as DocumentSummaryT),
		access: "member",
		body: null,
		confirmation: null,
		content: null,
		fields: [],
		legal: [],
		lines: null,
		page_count: 1,
		sha256: null,
		signature: null,
		signing_note: null,
	};
	const tasks: StoredTask[] = fx.accountPage.tasks.map((t) => clone(t));
	return {
		billing: clone(fx.accountPage.billing),
		created_at: fx.accountCard.organisation.created_at ?? now(),
		demo: clone(fx.accountCard.demo),
		docs: [offer, invoice, dpa],
		id: DEMO,
		members: clone(fx.accountCard.members),
		name: fx.accountPage.organisation.name,
		needs_form: clone(fx.accountCard.needs_form),
		needs_form_reference: fx.accountPage.needs_form_reference,
		pendingTasks: {},
		signatures: {},
		stage: fx.accountPage.organisation.account_stage,
		tasks,
		tickets: clone(fx.accountPage.tickets),
		timeline: clone(fx.accountCard.timeline),
		uploads: {},
	};
}

/** A few more rows so the staff list reads like a list; each opens its own card. */
function otherStores(): Store[] {
	const rows: [string, string, Store["stage"], string][] = [
		[
			"0199a2c0-0000-7000-8000-000000000001",
			"Example Water Board (sample)",
			"prospect",
			"2026-09-24T10:00:00.000Z",
		],
		[
			"0199a2c0-0000-7000-8000-000000000002",
			"Provincie Proefland",
			"customer",
			"2026-06-02T09:30:00.000Z",
		],
		[
			"0199a2c0-0000-7000-8000-000000000003",
			"Stichting Buurtkracht Demo",
			"churned",
			"2025-11-12T14:00:00.000Z",
		],
		// A free tier signup: an organisation with no account side yet.
		[
			"0199a2c0-0000-7000-8000-000000000004",
			"Stichting Vrije Proef",
			null,
			"2026-08-30T12:00:00.000Z",
		],
	];
	return rows.map(([id, name, stage, created]) => ({
		billing: { ...clone(fx.accountPage.billing), billing_email: null },
		created_at: created,
		demo: null,
		docs: [],
		id,
		members:
			stage === null
				? [
						{
							app_user_id: uuid(),
							email: "info@vrijeproef.example",
							name: "Joost",
							role: "owner",
							since: created,
						},
					]
				: [],
		name,
		needs_form: null,
		needs_form_reference: null,
		pendingTasks: {},
		signatures: {},
		stage,
		tasks: [],
		tickets: [],
		timeline: [
			{
				actor: "staff",
				actor_user_id: null,
				created_at: created,
				detail: { stage },
				id: uuid(),
				subject_id: null,
				subject_type: null,
				type: "account.created",
			},
		],
		uploads: {},
	}));
}

let stores: Record<string, Store> | null = null;

function load(): Record<string, Store> {
	if (stores) return stores;
	try {
		if (
			new URLSearchParams(window.location.search).get("fixtures") === "reset"
		) {
			sessionStorage.removeItem(KEY);
		}
		const raw = sessionStorage.getItem(KEY);
		if (raw) stores = JSON.parse(raw) as Record<string, Store>;
	} catch {
		stores = null;
	}
	if (!stores) {
		stores = {};
		for (const s of [demoStore(), ...otherStores()]) stores[s.id] = s;
	}
	return stores;
}

function save() {
	try {
		sessionStorage.setItem(KEY, JSON.stringify(stores));
		sessionStorage.setItem(DEMOS_KEY, JSON.stringify(demos ?? {}));
	} catch {
		// Private windows and full storage: the state then lasts until the next reload.
	}
}

// ── demos ──────────────────────────────────────────────────────────────

const DEMOS_KEY = "echo.accounts.fixtures.demos.v2";
/** `?fixtures_orgs=2` makes the signed-in customer an admin of two orgs with tasks. */
const ORGS_KEY = "echo.accounts.fixtures.orgs";
const STEP_MS = 1400;
const STEPS = [
	"fetch",
	"research",
	"author",
	"seed",
	"extract",
	"review",
] as const;

interface FixtureDemo extends DemoStatusT {
	/** A website URL with "fail" in it fails the author step once, to show a retry. */
	failOnce: boolean;
	offer: Record<string, unknown> | null;
}
let demos: Record<string, FixtureDemo> | null = null;

function loadDemos(): Record<string, FixtureDemo> {
	if (demos) return demos;
	try {
		if (
			new URLSearchParams(window.location.search).get("fixtures") === "reset"
		) {
			sessionStorage.removeItem(DEMOS_KEY);
		}
		demos = JSON.parse(sessionStorage.getItem(DEMOS_KEY) ?? "{}");
	} catch {
		demos = {};
	}
	return demos ?? {};
}

function twoOrgs(): boolean {
	try {
		const flag = new URLSearchParams(window.location.search).get(
			"fixtures_orgs",
		);
		if (flag) sessionStorage.setItem(ORGS_KEY, flag);
		return sessionStorage.getItem(ORGS_KEY) === "2";
	} catch {
		return false;
	}
}

/**
 * Moves a queued or running demo on by the time passed, one step every STEP_MS. The seed
 * step creates the organisation (a prospect with the contact as admin) and, when asked,
 * the offer as a draft, as the backend does.
 */
async function advance(d: FixtureDemo) {
	if (d.status !== "running" && d.status !== "queued") return;
	d.status = "running";
	const t = Date.now();
	for (const step of d.steps) {
		if (step.status === "done") continue;
		if (step.status === "failed") return;
		if (step.status === "pending") {
			step.status = "running";
			step.started_at = new Date(t).toISOString();
			return;
		}
		if (t - new Date(step.started_at ?? t).getTime() < STEP_MS) return;
		if (step.name === "author" && d.failOnce) {
			d.failOnce = false;
			step.status = "failed";
			step.error =
				fx.demoFailed.steps.find((x) => x.status === "failed")?.error ??
				"Failed";
			step.finished_at = new Date(t).toISOString();
			d.status = "failed";
			return;
		}
		step.status = "done";
		step.finished_at = new Date(t).toISOString();
		if (step.name === "author") d.conversations = 6;
		if (step.name === "research") d.research = fx.demoDraft.research;
		if (step.name === "seed") await seedOrg(d);
	}
	d.status = "draft";
	d.links = {
		...fx.demoDraft.links,
		account: `/api/v2/admin/accounts/${d.org_id}`,
		continue_url: `/login?next=${encodeURIComponent(`/o/${d.org_id}/account`)}`,
		projects: fx.demoDraft.links.projects.map((l) => ({
			...l,
			language: d.language,
		})),
		public: fx.demoDraft.links.public.map((l) => ({
			...l,
			language: d.language,
			live: false,
		})),
	};
}

async function seedOrg(d: FixtureDemo) {
	const org = uuid();
	const created = now();
	const base = otherStores()[0] as Store;
	const store: Store = {
		...base,
		created_at: created,
		demo: { slug: d.slug },
		id: org,
		members: [
			{
				app_user_id: uuid(),
				email: d.contact_email,
				name: null,
				role: "admin",
				since: created,
			},
		],
		name: d.organisation_name,
		stage: "prospect",
		timeline: [],
	};
	load()[org] = store;
	event(store, "account.created", "staff", {}, { stage: "prospect" });
	event(store, "demo.seeded", "staff", {}, { slug: d.slug });
	d.org_id = org;
	if (d.offer) {
		const res = (await handle(
			"pushOffer",
			{ orgId: org },
			{
				...d.offer,
				currency: "EUR",
				offer_name: d.organisation_name,
				send: false,
			},
		)) as { document: { id: string } };
		d.offer_document_id = res.document.id;
	}
}

/** Unknown org ids are the signed-in customer's own org in the dev shell: the demo. */
const storeFor = (orgId: string): Store =>
	load()[orgId] ?? (load()[DEMO] as Store);

const notFound = () => new AccountsApiError(404, "Not found");
const invalid = (field: string, msg: string) =>
	new AccountsApiError(422, msg, { [field]: msg });

const customerBase = (orgId: string) => `/api/v2/orgs/${orgId}/account`;
const staffBase = (orgId: string) => `/api/v2/admin/accounts/${orgId}`;

function withUrls(
	doc: DocumentDetailT,
	base: string,
	access: DocumentDetailT["access"],
): DocumentDetailT {
	return {
		...doc,
		access,
		file_url: `${base}/documents/${doc.id}/file`,
		signed_pdf_url:
			doc.status === "signed" ? `${base}/documents/${doc.id}/signed.pdf` : null,
	};
}

function summary(doc: DocumentDetailT): DocumentSummaryT {
	const {
		body: _b,
		content: _c,
		lines: _l,
		sha256: _s,
		page_count: _p,
		fields: _f,
		legal: _lg,
		signing_note: _n,
		confirmation: _cf,
		signature: _sg,
		access: _a,
		...rest
	} = doc;
	return rest;
}

const TASK_ORDER: Record<TaskT["status"], number> = {
	changes_requested: 1,
	done: 4,
	locked: 2,
	open: 0,
	submitted: 3,
	withdrawn: 5,
};

const publicTask = (t: StoredTask): TaskT => t;

const event = (
	s: Store,
	type: string,
	actor: Event["actor"],
	subject: { type?: string; id?: string } = {},
	detail: unknown = null,
) => {
	s.timeline.unshift({
		actor,
		actor_user_id: null,
		created_at: now(),
		detail,
		id: uuid(),
		subject_id: subject.id ?? null,
		subject_type: subject.type ?? null,
		type,
	});
};

function listItem(s: Store): Out<typeof AccountListItem> {
	return {
		created_at: s.created_at,
		id: s.id,
		name: s.name,
		open_tasks: s.tasks.filter(
			(t) => t.status === "open" || t.status === "changes_requested",
		).length,
		open_tickets: s.tickets.filter((t) => t.status !== "closed").length,
		overdue_invoices: s.docs.filter((d) => d.invoice?.status === "overdue")
			.length,
		stage: s.stage,
		unsigned_documents: s.docs.filter(
			(d) =>
				d.requires_signature && (d.status === "sent" || d.status === "viewed"),
		).length,
		waiting_on_us: s.tasks.filter((t) => t.status === "submitted").length,
	};
}

function card(s: Store) {
	const base = staffBase(s.id);
	return {
		account_manager: null,
		billing: s.billing,
		demo: s.demo,
		documents: s.docs.map((d) => summary(withUrls(d, base, "staff"))),
		members: s.members,
		needs_form: s.needs_form,
		organisation: {
			account_stage: s.stage,
			created_at: s.created_at,
			id: s.id,
			name: s.name,
		},
		pending_invites: [],
		tasks: s.tasks.map(publicTask),
		tickets: s.tickets,
		timeline: s.timeline,
		usage: {
			projects: s.id === DEMO ? 2 : 0,
			workspaces: s.id === DEMO ? 1 : 0,
		},
	};
}

const OFFER_LABELS = {
	en: [
		"Name",
		"Organisation",
		"Address",
		"VAT number",
		"Role",
		"Date of signing",
		"Signature",
	],
	nl: [
		"Naam",
		"Organisatie",
		"Adres",
		"Btw-nummer",
		"Functie",
		"Datum van ondertekening",
		"Handtekening",
	],
};

function offerFields(language: "en" | "nl") {
	const kinds = [
		"name",
		"text",
		"text",
		"text",
		"role",
		"date",
		"signature",
	] as const;
	const keys = [
		null,
		"organisation",
		"address",
		"vat_number",
		null,
		null,
		null,
	];
	return kinds.map((kind, i) => ({
		height: kind === "signature" ? 0.06 : 0.022,
		id: uuid(),
		key: keys[i] ?? null,
		kind,
		label: OFFER_LABELS[language][i] as string,
		page: 2,
		required: keys[i] !== "vat_number",
		signer_role: "signer" as const,
		sort: i,
		width: kind === "signature" ? 0.3 : 0.45,
		x: 0.36,
		y: [0.412, 0.438, 0.464, 0.49, 0.516, 0.542, 0.568][i] as number,
	}));
}

const randomHex = () =>
	Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
	return Array.from(new Uint8Array(digest), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
}

/**
 * The confirmation sentence as the server builds it: {role} only when the document has a
 * role field, {organisation} only when a text field is keyed "organisation" (otherwise the
 * organisation's own name is written in), {name} always.
 */
function confirmationFor(
	language: "en" | "nl",
	title: string,
	reference: string,
	sha: string,
	withDpa: boolean,
	fields: readonly { kind: string; key: string | null }[],
	orgName: string,
) {
	const role = fields.some((f) => f.kind === "role") ? ", {role}" : "";
	const org = fields.some((f) => f.kind === "text" && f.key === "organisation")
		? "{organisation}"
		: orgName;
	if (language === "nl") {
		const base = `Ik, {name}${role}, bevestig dat ik namens ${org} mag tekenen, en ik onderteken "${title}" (${reference}) zoals aan mij getoond, SHA-256 ${sha}.`;
		return withDpa
			? {
					dpa_authorised: `${base} Ik ben ook bevoegd om namens deze organisatie verwerkingsafspraken aan te gaan.`,
					dpa_not_authorised: `${base} Ik ben niet bevoegd om namens deze organisatie verwerkingsafspraken aan te gaan; de verwerkersovereenkomst wordt apart ondertekend.`,
				}
			: { dpa_authorised: base, dpa_not_authorised: null };
	}
	const base = `I, {name}${role}, confirm that I may sign on behalf of ${org}, and I sign "${title}" (${reference}) as shown to me, SHA-256 ${sha}.`;
	return withDpa
		? {
				dpa_authorised: `${base} I am also authorised to enter into data processing arrangements on behalf of this organisation.`,
				dpa_not_authorised: `${base} I am not authorised to enter into data processing arrangements on behalf of this organisation; the data processing agreement is signed separately.`,
			}
		: { dpa_authorised: base, dpa_not_authorised: null };
}

const fillConfirmation = (
	template: string,
	doc: DocumentDetailT,
	values: Record<string, string | boolean>,
) => {
	const byKind = (kind: string, key?: string) => {
		const f = doc.fields.find(
			(x) => x.kind === kind && (key === undefined || x.key === key),
		);
		const v = f ? values[f.id] : undefined;
		return typeof v === "string" ? v : "";
	};
	return template
		.split("{name}")
		.join(byKind("name"))
		.split("{role}")
		.join(byKind("role"))
		.split("{organisation}")
		.join(byKind("text", "organisation"));
};

function openTask(
	s: Store,
	t: Omit<
		StoredTask,
		| "code"
		| "params"
		| "locked_until_document_id"
		| "locked_until_title"
		| "id"
		| "opened_at"
		| "next_reminder_at"
		| "reminders_sent"
		| "response_text"
		| "response_file_name"
		| "submitted_at"
		| "review_note"
		| "reviewed_at"
	> & {
		locked_until: string | null;
		/** Tasks echo makes itself carry a code and params instead of text. */
		code?: TaskT["code"];
		params?: Record<string, string> | null;
	},
): StoredTask {
	const opened = t.locked ? null : now();
	const { locked_until, code = null, params = null, ...rest } = t;
	const task: StoredTask = {
		...rest,
		body: code ? null : rest.body,
		code,
		id: uuid(),
		locked_until_document_id: t.locked ? locked_until : null,
		locked_until_title: t.locked
			? (s.docs.find((d) => d.id === locked_until)?.title ?? null)
			: null,
		next_reminder_at: opened
			? addDays(opened, t.reminder_interval_days ?? 7)
			: null,
		opened_at: opened,
		params,
		reminders_sent: 0,
		response_file_name: null,
		response_text: null,
		review_note: null,
		reviewed_at: null,
		submitted_at: null,
		title: code ? null : rest.title,
	};
	s.tasks.push(task);
	return task;
}

function signTaskFor(
	s: Store,
	doc: DocumentDetailT,
	title: string,
	body: string | null,
) {
	// Offers and DPAs get the coded task echo makes; other documents keep the staff text.
	const code =
		doc.kind === "offer"
			? "sign_offer"
			: doc.kind === "dpa"
				? "sign_dpa"
				: null;
	return openTask(s, {
		body,
		code,
		document_id: doc.id,
		due_on: null,
		kind: "sign",
		locked: false,
		locked_until: null,
		params: code ? { document_title: doc.title } : null,
		reminder_interval_days: null,
		status: "open",
		title,
	});
}

/** A document ready to sign gets its confirmation from the fields it was sent with. */
function seal(s: Store, d: DocumentDetailT) {
	d.confirmation = confirmationFor(
		d.language,
		d.title,
		d.reference ?? d.id.slice(0, 8),
		d.sha256 ?? "",
		false,
		d.fields,
		s.name,
	);
	d.signing_note ??=
		d.language === "nl"
			? "Met je handtekening wordt dit document deel van de overeenkomst."
			: "Your signature makes this document part of the agreement.";
}

const publicDemo = ({
	failOnce: _f,
	offer: _o,
	...d
}: FixtureDemo): DemoStatusT => d;

type Body = Record<string, unknown>;

/** One handler per contract route; the client parses whatever this returns. */
export async function handle(
	name: RouteName,
	params: Params,
	rawBody: unknown,
	query?: Record<string, string | number | undefined>,
	fileName?: string,
): Promise<unknown> {
	// A beat of latency so loading states are seen, as they will be against the API.
	await new Promise((r) => setTimeout(r, 120));
	const body = (rawBody ?? {}) as Body;
	const orgId = params.orgId ?? DEMO;
	const s = storeFor(orgId);
	const doc = () => {
		const d = s.docs.find((x) => x.id === params.docId);
		if (!d) throw notFound();
		return d;
	};
	const task = () => {
		const t = s.tasks.find((x) => x.id === params.taskId);
		if (!t) throw notFound();
		return t;
	};
	const ticket = () => {
		const t = s.tickets.find((x) => x.id === params.ticketId);
		if (!t) throw notFound();
		return t;
	};
	const cBase = customerBase(orgId);
	const sBase = staffBase(s.id);
	const result = await (async (): Promise<unknown> => {
		switch (name) {
			case "createDemo": {
				const created = now();
				const d: FixtureDemo = {
					contact_email: String(body.contact_email),
					conversations: null,
					created_at: created,
					failOnce: String(body.website_url).includes("fail"),
					id: uuid(),
					invited_at: null,
					language: body.language as "en" | "nl",
					links: {
						account: null,
						continue_url: null,
						projects: [],
						public: [],
					},
					offer: (body.offer as Record<string, unknown> | null) ?? null,
					offer_document_id: null,
					org_id: null,
					organisation_name: String(body.organisation_name),
					published_at: null,
					research: null,
					sign_in: body.sign_in === true,
					slug: String(body.organisation_name)
						.toLowerCase()
						.replace(/[^a-z0-9]+/g, "-"),
					status: "queued",
					steps: STEPS.map((name) => ({
						error: null,
						finished_at: null,
						name,
						started_at: null,
						status: "pending" as const,
					})),
					updated_at: created,
					website_url: String(body.website_url),
				};
				loadDemos()[d.id] = d;
				await advance(d);
				return publicDemo(d);
			}
			case "listDemos": {
				for (const d of Object.values(loadDemos())) await advance(d);
				return {
					demos: Object.values(loadDemos())
						.sort((a, b) => b.created_at.localeCompare(a.created_at))
						.map(publicDemo),
				};
			}
			case "demoStatus":
			case "retryDemo":
			case "publishDemo": {
				const d = loadDemos()[params.demoId ?? ""];
				if (!d) throw notFound();
				if (name === "retryDemo") {
					const step = d.steps.find((x) => x.status === "failed");
					if (!step) throw new AccountsApiError(409, "No step failed.");
					step.status = "running";
					step.error = null;
					step.started_at = now();
					step.finished_at = null;
					d.status = "running";
				}
				await advance(d);
				if (name === "publishDemo") {
					if (d.status !== "draft")
						throw new AccountsApiError(409, "The draft is not ready yet.");
					const signIn =
						typeof body.sign_in === "boolean" ? body.sign_in : d.sign_in;
					d.sign_in = signIn;
					d.status = "published";
					d.published_at = now();
					d.invited_at = signIn ? now() : null;
					d.links.public = d.links.public.map((l) => ({ ...l, live: true }));
					const target = load()[d.org_id ?? ""];
					if (target)
						event(target, "demo.published", "staff", {}, { invited: signIn });
				}
				d.updated_at = now();
				return publicDemo(d);
			}
			case "enableAccount": {
				s.stage = (body.stage as Store["stage"]) ?? "customer";
				if (!s.tasks.some((x) => x.kind === "billing_details")) {
					openTask(s, {
						body:
							body.language === "en"
								? "Who we invoice."
								: "Aan wie we factureren.",
						code: "billing_details",
						document_id: null,
						due_on: null,
						kind: "billing_details",
						locked: false,
						locked_until: null,
						reminder_interval_days: null,
						status: "open",
						title:
							body.language === "en" ? "Billing details" : "Factuurgegevens",
					});
				}
				event(s, "account.enabled", "staff", {}, { stage: s.stage });
				return card(s);
			}
			case "tasksSummary": {
				// The customer's own org (whatever id the dev shell gives it) carries the demo's tasks.
				const me = await fetch(`${API_BASE_URL}/v2/me`, {
					credentials: "include",
				})
					.then((r) => (r.ok ? r.json() : null))
					.catch(() => null);
				const own = (me?.orgs?.[0] ?? null) as {
					id: string;
					name: string;
				} | null;
				const summarise = (id: string, name: string, x: Store) => {
					const live = x.tasks.filter((t) => t.status !== "withdrawn");
					return {
						account_stage: x.stage,
						logo_url: null,
						name,
						...(() => {
							const next = live.find(
								(t) => t.status === "open" || t.status === "changes_requested",
							);
							return {
								next_task_code: next?.code ?? null,
								next_task_params: next?.params ?? null,
								next_task_title: next && !next.code ? next.title : null,
							};
						})(),
						org_id: id,
						tasks_done: live.filter((t) => t.status === "done").length,
						tasks_total: live.length,
						tasks_waiting: live.filter(
							(t) => t.status === "open" || t.status === "changes_requested",
						).length,
					};
				};
				const rows = [];
				if (own) rows.push(summarise(own.id, own.name, load()[DEMO] as Store));
				if (twoOrgs()) {
					const second = load()[
						"0199a2c0-0000-7000-8000-000000000001"
					] as Store;
					if (!second.tasks.length) {
						openTask(second, {
							body: null,
							document_id: null,
							due_on: null,
							kind: "generic",
							locked: false,
							locked_until: null,
							reminder_interval_days: null,
							status: "open",
							title: "Stuur ons de datum van de bewonersavond",
						});
						const done = openTask(second, {
							body: null,
							document_id: null,
							due_on: null,
							kind: "generic",
							locked: false,
							locked_until: null,
							reminder_interval_days: null,
							status: "open",
							title: "Plan een kennismaking",
						});
						done.status = "done";
					}
					rows.push(summarise(second.id, second.name, second));
				}
				return rows;
			}
			case "accountPage":
				return {
					billing: s.billing,
					documents: s.docs
						.filter((d) => d.status !== "draft" && d.status !== "void")
						.map((d) => summary(withUrls(d, cBase, "member"))),
					needs_form_reference: s.needs_form_reference,
					organisation: { account_stage: s.stage, id: orgId, name: s.name },
					tasks: s.tasks
						.filter((t) => t.status !== "withdrawn")
						.sort((a, b) => TASK_ORDER[a.status] - TASK_ORDER[b.status])
						.map(publicTask),
					tickets: s.tickets,
				};
			case "readDocument":
				return withUrls(doc(), cBase, "member");
			case "staffReadDocument":
				return withUrls(doc(), sBase, "staff");
			case "viewDocument": {
				const d = doc();
				if (d.status === "sent") {
					d.status = "viewed";
					d.viewed_at = now();
					event(s, "document.viewed", "customer", {
						id: d.id,
						type: "document",
					});
				}
				return { status: d.status };
			}
			case "signDocument": {
				const d = doc();
				if (d.status !== "sent" && d.status !== "viewed") {
					throw new AccountsApiError(
						409,
						"This document is not open for signing.",
					);
				}
				if (body.sha256 !== d.sha256) {
					throw new AccountsApiError(
						409,
						"The document changed since you opened it. Reload and sign again.",
					);
				}
				const values = body.values as Record<string, string | boolean>;
				for (const f of d.fields) {
					if (!f.required || f.kind === "signature" || f.kind === "initials")
						continue;
					const v = values[f.id];
					if (v === undefined || v === "" || v === false)
						throw invalid(`values.${f.id}`, `${f.label} is required`);
				}
				const dpaAuthorised = body.dpa_authorised === true;
				const template =
					dpaAuthorised || !d.confirmation?.dpa_not_authorised
						? d.confirmation?.dpa_authorised
						: d.confirmation.dpa_not_authorised;
				const expected = template
					? fillConfirmation(template, d, values)
					: null;
				if (expected && expected !== body.confirmation_text) {
					throw invalid(
						"confirmation_text",
						"The confirmation text does not match the document.",
					);
				}
				const sig = body.signature as {
					png_base64: string;
					method: "drawn" | "typed" | "uploaded";
				};
				const pick = (kind: string, key?: string) => {
					const f = d.fields.find(
						(x) => x.kind === kind && (key === undefined || x.key === key),
					);
					const v = f ? values[f.id] : undefined;
					return typeof v === "string" && v ? v : null;
				};
				const signedAt = now();
				d.status = "signed";
				d.signed_at = signedAt;
				d.signature = {
					address: pick("text", "address"),
					dpa_authorised: dpaAuthorised,
					email: "robin@example-town.example",
					id: uuid(),
					image_sha256: await sha256Hex(
						Uint8Array.from(atob(sig.png_base64), (c) => c.charCodeAt(0)),
					),
					method: sig.method,
					name: pick("name") ?? "",
					organisation: pick("text", "organisation") ?? s.name,
					role: pick("role") ?? "",
					sha256: d.sha256 ?? "",
					signed_at: signedAt,
					values,
					vat_number: pick("text", "vat_number"),
				};
				s.signatures[d.id] = {
					confirmation: String(body.confirmation_text),
					png: sig.png_base64,
				};
				for (const t of s.tasks) {
					if (
						t.document_id === d.id &&
						t.kind === "sign" &&
						t.status !== "withdrawn"
					) {
						t.status = "done";
						t.next_reminder_at = null;
					}
					if (t.locked_until_document_id === d.id && t.locked) {
						t.locked = false;
						t.locked_until_document_id = null;
						t.locked_until_title = null;
						t.status = "open";
						t.opened_at = signedAt;
						t.next_reminder_at = addDays(
							signedAt,
							t.reminder_interval_days ?? 7,
						);
					}
				}
				event(
					s,
					"document.signed",
					"customer",
					{ id: d.id, type: "document" },
					{ dpa_authorised: dpaAuthorised },
				);
				if (d.kind === "offer" && !dpaAuthorised) {
					const dpa: DocumentDetailT = {
						...clone(fx.signedDpaDetail),
						declined_at: null,
						fields: fx.signedDpaDetail.fields.map((f) => ({
							...f,
							id: uuid(),
						})),
						id: uuid(),
						sent_at: signedAt,
						sha256: randomHex(),
						signature: null,
						signed_at: null,
						signer: null,
						status: "sent",
						viewed_at: null,
					};
					dpa.confirmation = confirmationFor(
						dpa.language,
						dpa.title,
						dpa.reference ?? "",
						dpa.sha256 ?? "",
						false,
						dpa.fields,
						s.name,
					);
					s.docs.unshift(dpa);
					signTaskFor(
						s,
						dpa,
						d.language === "nl"
							? "Verwerkersovereenkomst laten tekenen"
							: "Have the DPA signed",
						d.language === "nl"
							? "Iemand die namens jullie verwerkingsafspraken mag aangaan, tekent de verwerkersovereenkomst. Wijs diegene aan op het document."
							: "Someone who may agree to data processing for your organisation signs the DPA. Name them on the document.",
					);
				}
				return {
					confirmation_text: body.confirmation_text,
					signature_id: d.signature.id,
					signed_at: signedAt,
				};
			}
			case "declineDocument": {
				const d = doc();
				d.status = "declined";
				d.declined_at = now();
				event(
					s,
					"document.declined",
					"customer",
					{ id: d.id, type: "document" },
					{ reason: body.reason },
				);
				return { status: "declined" };
			}
			case "nameSigner": {
				const d = doc();
				const previous = d.signer;
				d.signer = {
					email: String(body.email),
					name: String(body.name),
					role: (body.role as string | null) ?? null,
				};
				const replaced = previous && previous.email !== d.signer.email;
				event(
					s,
					replaced ? "document.signer_replaced" : "document.signer_named",
					"customer",
					{ id: d.id, type: "document" },
					replaced
						? { email: body.email, previous_email: previous.email }
						: { email: body.email },
				);
				return { signer: d.signer };
			}
			case "readBilling":
				return s.billing;
			case "updateBilling": {
				if (!body.vat_id && !body.kvk_number && !body.kbo_number) {
					throw invalid("vat_id", "Give a VAT, KvK or KBO number.");
				}
				s.billing = { ...s.billing, ...(body as Partial<Billing>) };
				for (const t of s.tasks) {
					if (
						t.kind === "billing_details" &&
						(t.status === "open" || t.status === "changes_requested")
					) {
						// Saving the details completes the task: no staff review (CTO decision).
						t.status = "done";
						t.submitted_at = now();
						t.next_reminder_at = null;
					}
				}
				event(s, "billing_details.updated", "customer");
				return s.billing;
			}
			case "submitTask": {
				const t = task();
				t.status = "submitted";
				t.response_text = (body.response_text as string | null) ?? null;
				t.response_file_name = fileName ?? t.response_file_name;
				t.submitted_at = now();
				t.next_reminder_at = null;
				event(s, "task.submitted", "customer", { id: t.id, type: "task" });
				return publicTask(t);
			}
			case "openTicket":
			case "staffOpenTicket": {
				const from = name === "openTicket" ? "customer" : "dembrane";
				const t: TicketT = {
					closed_at: null,
					created_at: now(),
					id: uuid(),
					messages: [
						{ body: String(body.body), created_at: now(), from, id: uuid() },
					],
					status:
						from === "customer" ? "waiting_on_dembrane" : "waiting_on_customer",
					subject: String(body.subject),
					updated_at: now(),
				};
				s.tickets.unshift(t);
				event(s, "ticket.opened", from === "customer" ? "customer" : "staff", {
					id: t.id,
					type: "ticket",
				});
				return t;
			}
			case "replyTicket":
			case "staffReplyTicket": {
				const t = ticket();
				const from = name === "replyTicket" ? "customer" : "dembrane";
				t.messages.push({
					body: String(body.body),
					created_at: now(),
					from,
					id: uuid(),
				});
				t.updated_at = now();
				t.status =
					from === "customer" ? "waiting_on_dembrane" : "waiting_on_customer";
				if (body.close === true) {
					t.status = "closed";
					t.closed_at = now();
				}
				return t;
			}
			case "closeTicket": {
				const t = ticket();
				t.status = "closed";
				t.closed_at = now();
				return t;
			}
			case "recordBooking":
				event(s, "booking.recorded", "customer", {}, body);
				return { recorded: true };
			case "signingRequests":
				return s.docs
					.filter(
						(d) =>
							d.requires_signature &&
							(d.status === "sent" || d.status === "viewed"),
					)
					.map((d) => ({
						document: summary(withUrls(d, cBase, "signer")),
						organisation: { id: orgId, name: s.name },
					}));
			case "listAccounts": {
				const all = Object.values(load());
				const stage = query?.stage === "none" ? null : query?.stage;
				// PROVISIONAL: `q` matches the name or a member's email, as the backend will.
				const q = String(query?.q ?? "")
					.trim()
					.toLowerCase();
				const rows = all
					.filter((x) => stage === undefined || x.stage === stage)
					.filter(
						(x) =>
							!q ||
							x.name.toLowerCase().includes(q) ||
							x.members.some((m) => (m.email ?? "").toLowerCase().includes(q)),
					)
					.map(listItem);
				return {
					accounts: rows,
					limit: Number(query?.limit ?? 50),
					offset: Number(query?.offset ?? 0),
				};
			}
			case "createAccount":
				return fx.createAccountResponse;
			case "accountCard":
				return card(s);
			case "updateAccount":
				if (body.account_stage) {
					s.stage = body.account_stage as Store["stage"];
					event(s, "account.stage_set", "staff", {}, { stage: s.stage });
				}
				return card(s);
			case "pushOffer": {
				const language = body.language as "en" | "nl";
				const items = body.items as DocumentDetailT["content"] extends infer C
					? C extends { items: infer I }
						? I
						: never
					: never;
				const lines = items.map((it) => {
					const net = it.quantity * it.unit_price_cents;
					const vat = Math.round((net * it.vat_rate_bps) / 10_000);
					return {
						...it,
						net_cents: net,
						total_cents: net + vat,
						vat_cents: vat,
					};
				});
				const subtotal = lines.reduce((a, l) => a + l.net_cents, 0);
				const vat = lines.reduce((a, l) => a + l.vat_cents, 0);
				const date = (body.date as string | null) ?? today();
				const reference =
					(body.reference as string | null) ??
					`DMB-${Math.floor(Math.random() * 9000 + 1000)}`;
				const title =
					(body.title as string | null) ?? `${body.offer_name} x dembrane`;
				const sha = randomHex();
				if (body.supersedes_id) {
					const old = s.docs.find((x) => x.id === body.supersedes_id);
					if (old && old.status !== "signed") {
						old.status = "void";
						old.voided_at = now();
					}
				}
				const d: DocumentDetailT = {
					...clone(fx.offerDetail),
					confirmation: confirmationFor(
						language,
						title,
						reference,
						sha,
						true,
						offerFields(language),
						s.name,
					),
					content: {
						...clone(
							fx.offerDetail.content as NonNullable<DocumentDetailT["content"]>,
						),
						attention: (body.attention as string | null) ?? null,
						date,
						items,
						language,
						offer_name: String(body.offer_name),
						person_name: (body.person_name as string | null) ?? null,
						reference,
						template: body.template as "subscription" | "event",
					},
					currency: (body.currency as string) ?? "EUR",
					fields: offerFields(language),
					id: uuid(),
					language,
					lines,
					reference,
					sent_at: body.send === false ? null : now(),
					sha256: sha,
					signature: null,
					signed_at: null,
					signing_note:
						language === "nl"
							? "Met je handtekening is de overeenkomst compleet: wij kunnen factureren, en je voorwaarden, SLA en verwerkersovereenkomst gelden."
							: "Your signature completes the agreement: we can invoice, and the terms, SLA and data processing agreement apply.",
					status: body.send === false ? "draft" : "sent",
					subtotal_cents: subtotal,
					title,
					total_cents: subtotal + vat,
					valid_until: new Date(new Date(date).getTime() + 14 * 86_400_000)
						.toISOString()
						.slice(0, 10),
					vat_cents: vat,
					viewed_at: null,
				};
				s.docs.unshift(d);
				// A draft offer gets its task when it is sent.
				const t =
					body.send === false
						? null
						: signTaskFor(
								s,
								d,
								language === "nl"
									? "Offerte bekijken en ondertekenen"
									: "Review and sign the offer",
								language === "nl"
									? "Lees de offerte en onderteken hem hier."
									: "Read the offer and sign it here.",
							);
				const billing = s.tasks.find(
					(x) => x.kind === "billing_details" && x.status === "locked",
				);
				if (billing) {
					billing.locked_until_document_id = d.id;
					billing.locked_until_title = d.title;
				} else if (!s.tasks.some((x) => x.kind === "billing_details")) {
					openTask(s, {
						body:
							language === "nl"
								? "Aan wie we factureren. Deze stap opent zodra de offerte is ondertekend."
								: "Who we invoice. This step opens once the offer is signed.",
						code: "billing_details",
						document_id: null,
						due_on: null,
						kind: "billing_details",
						locked: true,
						locked_until: d.id,
						reminder_interval_days: null,
						status: "locked",
						title: language === "nl" ? "Factuurgegevens" : "Billing details",
					});
				}
				event(
					s,
					"document.sent",
					"staff",
					{ id: d.id, type: "document" },
					{ kind: "offer", total_cents: d.total_cents },
				);
				return {
					document: withUrls(d, sBase, "staff"),
					task: t ? publicTask(t) : null,
				};
			}
			case "pushDocument": {
				const pdf = body.pdf_base64 as string | null;
				const bytes = pdf
					? Uint8Array.from(atob(pdf), (c) => c.charCodeAt(0))
					: null;
				const fields = (body.fields as FieldInput[] | null) ?? null;
				const requires = body.requires_signature === true;
				const sendNow =
					body.send !== false && (!requires || (fields?.length ?? 0) > 0);
				const d: DocumentDetailT = {
					access: "staff",
					body: (body.body as string | null) ?? null,
					confirmation: null,
					content: null,
					currency: null,
					declined_at: null,
					fields: [],
					file_url: null,
					id: uuid(),
					invoice: undefined,
					kind: body.kind as "dpa" | "other",
					language: (body.language as "en" | "nl") ?? "en",
					legal: [],
					lines: null,
					page_count: bytes ? await pageCountOf(bytes) : 1,
					reference: (body.reference as string | null) ?? null,
					requires_signature: requires,
					sent_at: sendNow ? now() : null,
					sha256: bytes ? await sha256Hex(bytes) : randomHex(),
					signature: null,
					signed_at: null,
					signed_pdf_url: null,
					signer: null,
					signing_note: null,
					status: sendNow ? "sent" : "draft",
					subtotal_cents: null,
					title: (body.title as string | null) ?? "Document",
					total_cents: null,
					valid_until: null,
					vat_cents: null,
					version: 1,
					viewed_at: null,
					voided_at: null,
				};
				if (fields)
					d.fields = fields.map((f, i) => ({
						...f,
						id: uuid(),
						key: f.key ?? null,
						required: f.required ?? true,
						signer_role: "signer",
						sort: i,
					}));
				if (pdf) s.uploads[d.id] = pdf;
				s.docs.unshift(d);
				const taskSpec = body.task as {
					title: string;
					body: string | null;
				} | null;
				if (taskSpec && !sendNow) s.pendingTasks[d.id] = taskSpec;
				if (sendNow && requires) seal(s, d);
				const t =
					taskSpec && sendNow
						? requires
							? signTaskFor(s, d, taskSpec.title, taskSpec.body)
							: openTask(s, {
									body: taskSpec.body,
									document_id: d.id,
									due_on: null,
									kind: "generic",
									locked: false,
									locked_until: null,
									reminder_interval_days: null,
									status: "open",
									title: taskSpec.title,
								})
						: null;
				event(
					s,
					sendNow ? "document.sent" : "document.drafted",
					"staff",
					{ id: d.id, type: "document" },
					{ kind: d.kind },
				);
				return {
					document: withUrls(d, sBase, "staff"),
					task: t ? publicTask(t) : null,
				};
			}
			case "staffDocumentFields": {
				const d = doc();
				return {
					document_id: d.id,
					fields: d.fields,
					page_count: d.page_count,
					status: d.status,
				};
			}
			case "setDocumentFields": {
				const d = doc();
				if (d.status !== "draft")
					throw new AccountsApiError(
						409,
						"A sent document's fields are fixed.",
					);
				const fields = body.fields as FieldInput[];
				d.fields = fields
					.map((f) => ({
						...f,
						id: uuid(),
						key: f.key ?? null,
						required: f.required ?? true,
						signer_role: "signer" as const,
						sort: 0,
					}))
					.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x)
					.map((f, i) => ({ ...f, sort: i }));
				return {
					document_id: d.id,
					fields: d.fields,
					page_count: d.page_count,
					status: d.status,
				};
			}
			case "sendDocument": {
				const d = doc();
				if (d.status !== "draft")
					throw new AccountsApiError(409, "Only a draft can be sent.");
				if (
					d.requires_signature &&
					!(
						d.fields.some((f) => f.kind === "signature") &&
						d.fields.some((f) => f.kind === "name")
					)
				) {
					throw new AccountsApiError(
						422,
						"A document to sign needs a name field and a signature field.",
					);
				}
				d.status = "sent";
				d.sent_at = now();
				// An offer keeps the confirmation its template gave it; other documents get
				// theirs from the fields they were sent with.
				if (d.requires_signature && d.kind !== "offer") seal(s, d);
				const offerTask =
					d.kind === "offer"
						? d.language === "nl"
							? {
									body: "Lees de offerte en onderteken hem hier.",
									title: "Offerte bekijken en ondertekenen",
								}
							: {
									body: "Read the offer and sign it here.",
									title: "Review and sign the offer",
								}
						: null;
				const taskSpec =
					(body.task as { title: string; body: string | null } | null) ??
					s.pendingTasks[d.id] ??
					offerTask;
				delete s.pendingTasks[d.id];
				if (!s.tasks.some((t) => t.document_id === d.id)) {
					if (d.requires_signature) {
						signTaskFor(
							s,
							d,
							taskSpec?.title ?? `Sign: ${d.title}`,
							taskSpec?.body ?? null,
						);
					} else if (taskSpec) {
						openTask(s, {
							body: taskSpec.body,
							document_id: d.id,
							due_on: null,
							kind: "generic",
							locked: false,
							locked_until: null,
							reminder_interval_days: null,
							status: "open",
							title: taskSpec.title,
						});
					}
				}
				event(
					s,
					"document.sent",
					"staff",
					{ id: d.id, type: "document" },
					{ kind: d.kind },
				);
				return withUrls(d, sBase, "staff");
			}
			case "voidDocument": {
				const d = doc();
				d.status = "void";
				d.voided_at = now();
				for (const t of s.tasks) {
					if (t.document_id === d.id && t.status !== "done")
						t.status = "withdrawn";
				}
				event(
					s,
					"document.voided",
					"staff",
					{ id: d.id, type: "document" },
					{ reason: body.reason },
				);
				return withUrls(d, sBase, "staff");
			}
			case "upsertInvoice":
				throw new AccountsApiError(501, "Invoices come from sam in the demo.");
			case "createTask": {
				const lockDoc = body.locked_until_document_id
					? s.docs.find((d) => d.id === body.locked_until_document_id)
					: null;
				const locked = Boolean(lockDoc && lockDoc.status !== "signed");
				const t = openTask(s, {
					body: (body.body as string | null) ?? null,
					document_id: (body.document_id as string | null) ?? null,
					due_on: (body.due_on as string | null) ?? null,
					kind: (body.kind as TaskT["kind"]) ?? "generic",
					locked,
					locked_until: lockDoc?.id ?? null,
					reminder_interval_days:
						(body.reminder_interval_days as number | null) ?? null,
					status: locked ? "locked" : "open",
					title: String(body.title),
				});
				event(s, "task.created", "staff", { id: t.id, type: "task" });
				return publicTask(t);
			}
			case "reviewTask": {
				const t = task();
				const decision = body.decision as "approve" | "send_back" | "withdraw";
				if (decision === "send_back" && !body.note)
					throw invalid("note", "Say what to change.");
				t.status =
					decision === "approve"
						? "done"
						: decision === "send_back"
							? "changes_requested"
							: "withdrawn";
				t.review_note = (body.note as string | null) ?? null;
				t.reviewed_at = now();
				t.next_reminder_at =
					decision === "send_back"
						? addDays(now(), t.reminder_interval_days ?? 7)
						: null;
				event(s, `task.${decision}`, "staff", { id: t.id, type: "task" });
				return publicTask(t);
			}
		}
		throw notFound();
	})();
	save();
	return result;
}

/** The PDF behind a file_url or signed_pdf_url, built on first use. */
export async function pdfFor(url: string): Promise<Uint8Array> {
	// `?fixtures_missing=1` makes unsigned files answer 404, to walk the missing-file state.
	try {
		const flag = new URLSearchParams(window.location.search).get(
			"fixtures_missing",
		);
		if (flag !== null)
			sessionStorage.setItem("echo.accounts.fixtures.missing", flag);
		if (
			sessionStorage.getItem("echo.accounts.fixtures.missing") === "1" &&
			url.endsWith("/file")
		) {
			throw new AccountsApiError(404, "Not found");
		}
	} catch (e) {
		if (e instanceof AccountsApiError) throw e;
	}
	const match = url.match(/documents\/([0-9a-f-]{36})\/(file|signed\.pdf)/);
	if (!match) throw notFound();
	const [, id, which] = match;
	for (const s of Object.values(load())) {
		const d = s.docs.find((x) => x.id === id);
		if (!d) continue;
		const upload = s.uploads[d.id];
		const unsigned = upload
			? Uint8Array.from(atob(upload), (c) => c.charCodeAt(0))
			: await renderUnsigned(d);
		if (which === "file") return unsigned;
		const signed = s.signatures[d.id];
		return renderSigned(
			unsigned,
			d,
			signed?.png ?? null,
			signed?.confirmation ?? null,
		);
	}
	throw notFound();
}

/** For tests: drop the in-memory copy. */
export function resetFixtures() {
	stores = null;
	demos = null;
	try {
		sessionStorage.removeItem(KEY);
	} catch {}
}
