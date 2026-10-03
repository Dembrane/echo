// The flow map: every page src/Router.tsx can route to (e2e/routes.ts reads
// them), and how the rendered grammar check (e2e/grammar.spec.ts) visits it.
// scripts/flows.test.ts fails when a router path has no entry here, or an entry
// names a path the router no longer has. Data only: vitest imports this file.
//
// A key is the path as routes.ts prints it. An entry either says how to visit
// the page or skips it with the reason.
//
//   params     ":name" -> a fixture ("$project") or a literal. A list visits
//              the page once per value (tabs behind a splat or :tab).
//   variants   more visits with some params swapped: "empty" is every project
//              page again on a project with nothing in it, in the check's own
//              workspace, for the empty states.
//   states     what to open on the page before checking it again: a name and
//              the data-testids to click in order. The page as it loads is
//              always checked first, so states only lists what is behind a
//              click: modals, menus, wizard steps, toggles.
//   auth       false for pages a signed-out visitor sees. Dashboard pages are
//              signed in by default, portal pages never are.
//   roles      who to visit as; "owner" (the default) is the demo workspace's
//              owner, "staff" a dembrane admin.
//   viewports  "desktop" 1280 and "phone" 390; both by default.

export type Fixture =
	| "$workspace"
	| "$project"
	| "$org"
	| "$conversation"
	| "$doc"
	| "$chat"
	| "$presentation"
	| "$canvas"
	| "$recipe"
	| "$demo"
	| "$ownWorkspace"
	| "$emptyProject";
export type State = { name: string; clicks: string[] };
export type Flow = {
	skip?: string;
	auth?: false;
	params?: Record<string, Fixture | string | string[]>;
	variants?: { name: string; params: Record<string, Fixture | string> }[];
	states?: State[];
	roles?: ("owner" | "staff")[];
	viewports?: ("desktop" | "phone")[];
};

const REDIRECT = { skip: "redirect: only sends you to another page" };
const TOKEN = (what: string) => ({
	skip: `needs a one-time ${what} token the check can't mint`,
});

const project = {
	projectId: "$project",
	workspaceId: "$workspace",
} as const;
const EMPTY = [
	{
		name: "empty",
		params: { projectId: "$emptyProject", workspaceId: "$ownWorkspace" },
	},
] as const satisfies Flow["variants"];

export const flows: Record<string, Flow> = {
	"/": REDIRECT,

	"/:projectId": REDIRECT,
	"/:projectId/*": { params: { "*": "no-such-page", projectId: "$project" } },
	"/:projectId/conversation/:conversationId": {
		skip: "records audio: needs a live participant conversation and a microphone",
	},
	"/:projectId/conversation/:conversationId/finish": {
		params: { conversationId: "$conversation", projectId: "$project" },
	},
	"/:projectId/conversation/:conversationId/refine": {
		params: { conversationId: "$conversation", projectId: "$project" },
	},
	"/:projectId/conversation/:conversationId/text": {
		params: { conversationId: "$conversation", projectId: "$project" },
	},
	"/:projectId/conversation/:conversationId/verify": {
		params: { conversationId: "$conversation", projectId: "$project" },
	},
	"/:projectId/conversation/:conversationId/verify/approve": {
		params: { conversationId: "$conversation", projectId: "$project" },
	},
	"/:projectId/report": { params: { projectId: "$project" } },
	"/:projectId/start": { params: { projectId: "$project" } },
	"/:projectId/unsubscribe": { params: { projectId: "$project" } },
	"/*": { auth: false, params: { "*": "no-such-page" } },
	"/account": {},

	"/admin": REDIRECT,
	"/admin/:tab": {
		params: {
			tab: [
				"usage-and-billing",
				"payments",
				"accounts",
				"partners",
				"managed-billing",
				"training",
				"response-feedback",
			],
		},
		roles: ["staff"],
	},
	"/admin/accounts/:orgId": { params: { orgId: "$org" }, roles: ["staff"] },
	"/admin/accounts/:orgId/documents/:docId/fields": {
		params: { docId: "$doc", orgId: "$org" },
		roles: ["staff"],
	},
	"/admin/accounts/demos/:demoId": {
		params: { demoId: "$demo" },
		roles: ["staff"],
	},
	"/admin/accounts/new-demo": { roles: ["staff"] },
	"/check-your-email": { auth: false },
	"/connect-agent": {},
	"/invite/accept": TOKEN("invite"),
	"/invites": {},
	"/login": { auth: false },
	"/o": {},
	"/o/:organisationId/*": {
		params: {
			"*": ["overview", "usage", "billing", "training", "agents", "members"],
			organisationId: "$org",
		},
	},
	"/o/:organisationId/account": { params: { organisationId: "$org" } },
	"/o/:organisationId/account/documents/:docId/sign": {
		params: { docId: "$doc", organisationId: "$org" },
	},
	"/onboarding": {
		skip: "shown only before onboarding completes; the check's login has completed it",
	},
	"/password-reset": TOKEN("password-reset"),
	"/present/public/:token": TOKEN("public presentation"),
	"/present/screen/:presentationId": {
		params: { presentationId: "$presentation" },
	},
	"/register": { auth: false },
	"/release-notes": {},
	"/request-password-reset": { auth: false },
	"/settings": {},
	"/settings/:section": {
		params: { section: ["access", "appearance", "assistant"] },
	},
	"/settings/agents/authorize": {
		skip: "an OAuth consent step: needs a pending agent authorisation request",
	},
	"/verify-email": TOKEN("email-verification"),

	"/w/:workspaceId": REDIRECT,
	"/w/:workspaceId/home": {
		params: { workspaceId: "$workspace" },
		states: [{ clicks: ["projects-select-button"], name: "select" }],
	},
	"/w/:workspaceId/members/*": {
		params: { "*": "", workspaceId: "$workspace" },
	},
	"/w/:workspaceId/projects": REDIRECT,

	"/w/:workspaceId/projects/:projectId": REDIRECT,
	"/w/:workspaceId/projects/:projectId/access": {
		params: project,
		variants: [...EMPTY],
	},
	"/w/:workspaceId/projects/:projectId/analysis": {
		params: project,
		variants: [...EMPTY],
	},
	"/w/:workspaceId/projects/:projectId/analysis/:tab": {
		params: { ...project, tab: ["results", "recipes", "runs"] },
	},
	"/w/:workspaceId/projects/:projectId/analysis/recipes/:recipeId": {
		params: { ...project, recipeId: "$recipe" },
	},
	"/w/:workspaceId/projects/:projectId/canvases/:canvasId": {
		params: { ...project, canvasId: "$canvas" },
	},
	"/w/:workspaceId/projects/:projectId/chats/:chatId": {
		params: { ...project, chatId: "$chat" },
		states: [{ clicks: ["chat-item-menu-button"], name: "menu" }],
	},
	"/w/:workspaceId/projects/:projectId/chats/:chatId/debug": {
		skip: "a developer page, outside the grammar",
	},
	"/w/:workspaceId/projects/:projectId/chats/new": {
		params: project,
		states: [
			{ clicks: ["chat-templates-more-button"], name: "templates" },
			{ clicks: ["ask-home-try-agentic"], name: "agentic intro" },
		],
		variants: [...EMPTY],
	},
	"/w/:workspaceId/projects/:projectId/conversations": {
		params: project,
		states: [{ clicks: ["conversation-upload-button"], name: "upload" }],
		variants: [...EMPTY],
	},
	"/w/:workspaceId/projects/:projectId/conversations/:conversationId": {
		params: { ...project, conversationId: "$conversation" },
		states: [
			{ clicks: ["conversation-move-button"], name: "move" },
			{ clicks: ["conversation-delete-button"], name: "delete" },
			{ clicks: ["transcript-download-button"], name: "download" },
			{ clicks: ["transcript-retranscribe-button"], name: "retranscribe" },
		],
	},
	"/w/:workspaceId/projects/:projectId/conversations/:conversationId/debug": {
		skip: "a developer page, outside the grammar",
	},
	"/w/:workspaceId/projects/:projectId/conversations/:conversationId/overview":
		REDIRECT,
	"/w/:workspaceId/projects/:projectId/conversations/:conversationId/transcript":
		REDIRECT,
	"/w/:workspaceId/projects/:projectId/debug": {
		skip: "a developer page, outside the grammar",
	},
	"/w/:workspaceId/projects/:projectId/export": {
		params: project,
		variants: [...EMPTY],
	},
	"/w/:workspaceId/projects/:projectId/home": {
		params: project,
		states: [{ clicks: ["project-home-rename-button"], name: "rename" }],
		variants: [...EMPTY],
	},
	"/w/:workspaceId/projects/:projectId/host-guide": {
		params: project,
		variants: [...EMPTY],
	},
	"/w/:workspaceId/projects/:projectId/integrations": {
		params: project,
		variants: [...EMPTY],
	},
	"/w/:workspaceId/projects/:projectId/library": {
		params: project,
		variants: [...EMPTY],
	},
	"/w/:workspaceId/projects/:projectId/library/popcorn": REDIRECT,
	"/w/:workspaceId/projects/:projectId/map": {
		params: project,
		variants: [...EMPTY],
	},
	"/w/:workspaceId/projects/:projectId/monitor": {
		params: project,
		variants: [...EMPTY],
	},
	"/w/:workspaceId/projects/:projectId/overview": {
		params: project,
		states: [
			{ clicks: ["project-actions-clone-button"], name: "clone" },
			{ clicks: ["project-actions-delete-button"], name: "delete" },
		],
		variants: [...EMPTY],
	},
	// Its switches save as they change, on demo data the other sessions share,
	// so only the preview, which changes nothing, is opened.
	"/w/:workspaceId/projects/:projectId/portal-editor": {
		params: project,
		states: [{ clicks: ["portal-editor-preview-toggle"], name: "preview" }],
		variants: [...EMPTY],
	},
	"/w/:workspaceId/projects/:projectId/present": {
		params: project,
		variants: [...EMPTY],
	},
	"/w/:workspaceId/projects/:projectId/present/:presentationId/edit": {
		params: { ...project, presentationId: "$presentation" },
	},
	"/w/:workspaceId/projects/:projectId/report": {
		params: project,
		states: [
			{ clicks: ["report-actions-menu"], name: "actions" },
			{ clicks: ["report-update-button"], name: "update" },
		],
		variants: [...EMPTY],
	},
	"/w/:workspaceId/projects/:projectId/sharing": REDIRECT,
	"/w/:workspaceId/projects/:projectId/upload": {
		params: project,
		variants: [...EMPTY],
	},
	"/w/:workspaceId/projects/:projectId/usage": {
		params: project,
		variants: [...EMPTY],
	},
	"/w/:workspaceId/projects/new": { params: { workspaceId: "$workspace" } },
	"/w/:workspaceId/settings/*": {
		params: {
			"*": ["general", "members", "training", "billing", "danger"],
			workspaceId: "$workspace",
		},
	},
	"/w/new": {},
};
