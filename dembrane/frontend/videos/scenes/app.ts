import { click, hideCursor, moveTo, reveal, type } from "../lib/cursor.ts";
import type { Ctx, Scene } from "../lib/scene.ts";

// Scenes that drive the dashboard and the portal. Selectors are test ids or URLs, never
// visible text, so the same scene records in every language.

const project = (ctx: Ctx, rest = "") =>
	ctx.url(
		`/w/${ctx.fixtures.workspace_id}/projects/${ctx.fixtures.project_id}${rest}`,
	);

const settle = (ctx: Ctx, ms = 1200) => ctx.page.waitForTimeout(ms);

export const bestPractices: Scene = {
	about: "The best practices sample project, and its answer on how to start",
	id: "best-practices",
	async run(ctx) {
		const { page } = ctx;
		const pid = ctx.fixtures.best_practices_project_id;
		await ctx.say(
			{
				en: "Every new account comes with a sample project: invented conversations about how organisations use dembrane.",
				nl: "Elk nieuw account krijgt een voorbeeldproject: verzonnen gesprekken over hoe organisaties dembrane gebruiken.",
			},
			async () => {
				await click(page, page.getByTestId(`project-list-item-${pid}`));
				await page.getByTestId("sample-project-notice").waitFor();
				await settle(ctx, 600);
				await moveTo(page, page.getByTestId("sample-project-notice"));
			},
		);
		await ctx.say(
			{
				en: "Start by asking it how to set up your first project.",
				nl: "Begin met de vraag hoe je je eerste project opzet.",
			},
			async () => {
				await click(
					page,
					page.locator(`a[href$="/projects/${pid}/chats/new"]`).first(),
				);
				const chat = page
					.locator(`a[href*="/chats/${ctx.fixtures.best_practices_chat_id}"]`)
					.first();
				await chat.waitFor();
				await settle(ctx, 500);
				await click(page, chat);
				await page.getByTestId("chat-interface").waitFor();
				// Hold on the question and the start of the answer before scrolling.
				await settle(ctx, 2500);
			},
		);
		await ctx.say(
			{
				en: "The answer gives six habits, and names the conversations each one comes from.",
				nl: "Het antwoord geeft zes gewoontes, en noemt bij elke gewoonte de gesprekken waar die vandaan komt.",
			},
			async () => {
				await page.getByTestId("chat-interface").hover();
				for (let i = 0; i < 5; i++) {
					await page.mouse.wheel(0, 220);
					await settle(ctx, 900);
				}
			},
		);
		await hideCursor(page);
	},
	async setup(ctx) {
		await ctx.page.goto(ctx.url(`/w/${ctx.fixtures.workspace_id}/home`));
		await ctx.page
			.getByTestId(
				`project-list-item-${ctx.fixtures.best_practices_project_id}`,
			)
			.waitFor();
	},
	since: "v3.0.0",
};

export const home: Scene = {
	about: "Home: the starting point, and search across everything",
	id: "home",
	async run(ctx) {
		const { page } = ctx;
		await ctx.say({
			en: "After you sign in, you start at Home. It lists the organisations and workspaces you belong to.",
			nl: "Na het inloggen begin je op Home. Daar staan de organisaties en werkruimtes waar je bij hoort.",
		});
		await ctx.say(
			{
				en: "Search finds any project, conversation or setting.",
				nl: "Met zoeken vind je elk project, gesprek of elke instelling.",
			},
			async () => {
				await type(page, page.locator("main input").first(), "heat");
				await settle(ctx, 1500);
			},
		);
	},
	async setup(ctx) {
		await ctx.page.goto(ctx.url("/o"));
		await ctx.page.locator("main input").first().waitFor();
	},
	since: "v2.0.0",
};

export const createProject: Scene = {
	about: "Create a project: name, context, key terms, access",
	id: "create-project",
	async run(ctx) {
		const { page } = ctx;
		const id = (s: string) => page.getByTestId(s);
		await ctx.say(
			{
				en: "Every listening process lives in a project. Name it after the question you're exploring.",
				nl: "Elk luistertraject krijgt een eigen project. Geef het de naam van de vraag die je onderzoekt.",
			},
			async () => {
				await click(page, id("project-home-create-button"));
				await type(
					page,
					id("create-project-name-input"),
					ctx.lang === "nl"
						? "Plannen voor het Rivierpark"
						: "Riverside Park plans",
				);
			},
		);
		await ctx.say(
			{
				en: "The project context tells dembrane what you want to learn. Chat answers and summaries stay on that question.",
				nl: "In de projectcontext vertel je dembrane wat je wilt leren. Chatantwoorden en samenvattingen blijven bij die vraag.",
			},
			() =>
				type(
					page,
					id("create-project-context-input"),
					ctx.lang === "nl"
						? "Wat willen bewoners van het park, en waar maken ze zich zorgen over?"
						: "What do residents want from the park, and what worries them?",
					30,
				),
		);
		await click(page, id("create-project-continue-button"));
		await ctx.say(
			{
				en: "Key terms help transcription spell the names and places that matter.",
				nl: "Kernbegrippen helpen de transcriptie om namen en plekken goed te spellen.",
			},
			async () => {
				await type(
					page,
					id("create-project-key-terms-input"),
					"Riverside Park",
				);
				await page.keyboard.press("Enter");
				await settle(ctx, 600);
			},
		);
		await click(page, id("create-project-continue-button"));
		await ctx.say({
			en: "Choose who can see it. You can change this later.",
			nl: "Kies wie het kan zien. Dat kun je later aanpassen.",
		});
		await click(page, id("create-project-continue-button"));
		await settle(ctx, 800);
		await click(page, id("create-project-submit-button"));
		await page.getByTestId("share-qr").waitFor();
		// The portal scene records into this project, so the sample keeps its 25 conversations.
		ctx.shared.projectId =
			page.url().match(/projects\/([0-9a-f-]{36})/)?.[1] ?? "";
		await hideCursor(page);
		await settle(ctx, 1500);
	},
	async setup(ctx) {
		await ctx.page.goto(ctx.url(`/w/${ctx.fixtures.workspace_id}/home`));
		await ctx.page.getByTestId("project-home-create-button").waitFor();
	},
	since: "v2.0.0",
};

export const share: Scene = {
	about: "Invite participants with the QR code or link",
	id: "share",
	async run(ctx) {
		const { page } = ctx;
		await ctx.say(
			{
				en: "Participants join with this QR code or link. Print it on the tables, or share it in a message.",
				nl: "Deelnemers doen mee via deze QR-code of link. Leg hem op tafel of deel hem in een bericht.",
			},
			async () => {
				await moveTo(
					page,
					page.getByTestId("share-qr").locator("svg, canvas, img").first(),
				);
				await settle(ctx, 600);
				await moveTo(page, page.getByTestId("share-event-printouts"));
			},
		);
		await hideCursor(page);
	},
	async setup(ctx) {
		await ctx.page.goto(project(ctx, "/home"));
		await ctx.page.getByTestId("share-qr").waitFor();
	},
	since: "v2.0.0",
};

export const portal: Scene = {
	about: "The participant's side, on a phone",
	device: "phone",
	id: "portal",
	async run(ctx) {
		const { page } = ctx;
		await ctx.say({
			en: "On their phone, participants first read who holds their data and how it is used.",
			nl: "Op hun telefoon lezen deelnemers eerst wie hun gegevens beheert en wat ermee gebeurt.",
		});
		await ctx.say(
			{
				en: "They give their table a name, and they're ready. No account, no app to install.",
				nl: "Ze geven hun tafel een naam en kunnen beginnen. Zonder account en zonder app.",
			},
			async () => {
				const next = page.getByTestId("portal-onboarding-next-button");
				for (let i = 0; i < 6 && (await next.isVisible()); i++) {
					await click(page, next);
					await settle(ctx, 900);
				}
				await type(
					page,
					page.getByTestId("portal-initiate-name-input"),
					ctx.lang === "nl" ? "Tafel 3" : "Table 3",
				);
				await click(page, page.getByTestId("portal-initiate-next-button"));
				await page.getByTestId("portal-audio-record-button").waitFor();
			},
		);
		await ctx.say(
			{
				en: "One tap starts the recording of the conversation at their table.",
				nl: "Met één tik begint de opname van het gesprek aan hun tafel.",
			},
			() => moveTo(page, page.getByTestId("portal-audio-record-button")),
		);
	},
	async setup(ctx) {
		const projectId = ctx.shared.projectId || ctx.fixtures.project_id;
		await ctx.page.goto(ctx.portalUrl(`/${projectId}/start`));
		await ctx.page.getByTestId("portal-onboarding-next-button").waitFor();
	},
	since: "v2.0.0",
};

export const conversations: Scene = {
	about: "Conversations: transcripts and summaries",
	id: "conversations",
	async run(ctx) {
		const { page } = ctx;
		await ctx.say({
			en: "Every recording arrives here as a conversation, transcribed and summarised.",
			nl: "Elke opname komt hier binnen als gesprek, uitgeschreven en samengevat.",
		});
		await ctx.say(
			{
				en: "Open one to read the summary, then the full transcript, in the participants' own words.",
				nl: "Open er een voor de samenvatting en daarna het volledige transcript, in de woorden van de deelnemers.",
			},
			async () => {
				await click(
					page,
					page
						.locator('[data-testid^="project-conversation-row-"]', {
							hasText: "Table 8",
						})
						.first(),
				);
				await settle(ctx, 1800);
				await moveTo(
					page,
					page.getByTestId("conversation-overview-summary-content"),
				);
				await settle(ctx, 1500);
				await reveal(page, page.getByTestId("transcript-title"));
				await moveTo(page, page.getByTestId("transcript-chunk-1"));
				await settle(ctx, 2000);
			},
		);
		await hideCursor(page);
	},
	async setup(ctx) {
		await ctx.page.goto(project(ctx, "/conversations"));
		await ctx.page
			.locator('[data-testid^="project-conversation-row-"]')
			.first()
			.waitFor();
	},
	since: "v2.0.0",
};

export const ask: Scene = {
	about: "Ask: questions across all conversations, answers with sources",
	id: "ask",
	async run(ctx) {
		const { page } = ctx;
		await ctx.say({
			en: "In Ask, you put questions to all your conversations at once.",
			nl: "Bij Stel vraag leg je een vraag voor aan al je gesprekken tegelijk.",
		});
		await ctx.say(
			{
				en: "Answers point back to the conversations they come from, so you can check what was really said.",
				nl: "Antwoorden verwijzen naar de gesprekken waar ze vandaan komen, zodat je kunt nagaan wat er echt gezegd is.",
			},
			async () => {
				const chat = page.getByTestId("chat-interface");
				await chat.hover();
				for (let i = 0; i < 4; i++) {
					await page.mouse.wheel(0, 260);
					await settle(ctx, 700);
				}
			},
		);
	},
	async setup(ctx) {
		await ctx.page.goto(project(ctx, `/chats/${ctx.fixtures.chat_id}`));
		await ctx.page.getByTestId("chat-interface").waitFor();
		await ctx.page.waitForTimeout(1500);
		// Start at the question, not wherever the chat restored its scroll.
		await ctx.page.getByTestId("chat-interface").evaluate((el) => {
			const scroller = [el, ...el.querySelectorAll("*")].find(
				(e) =>
					e.scrollHeight > e.clientHeight + 40 &&
					getComputedStyle(e).overflowY !== "visible",
			);
			if (scroller) scroller.scrollTop = 0;
		});
	},
	since: "v2.0.0",
};

export const report: Scene = {
	about: "Report: a shareable write-up of what was heard",
	id: "report",
	async run(ctx) {
		const { page } = ctx;
		await ctx.say({
			en: "When you are ready, turn the conversations into a report.",
			nl: "Als je zover bent, maak je van de gesprekken een rapport.",
		});
		await ctx.say(
			{
				en: "Edit it, publish it, and share the link with participants and decision makers.",
				nl: "Pas het aan, publiceer het en deel de link met deelnemers en beslissers.",
			},
			async () => {
				await page.getByTestId("report-renderer-container").hover();
				for (let i = 0; i < 3; i++) {
					await page.mouse.wheel(0, 300);
					await settle(ctx, 900);
				}
				await moveTo(page, page.getByTestId("share-button"));
			},
		);
		await hideCursor(page);
	},
	async setup(ctx) {
		await ctx.page.goto(project(ctx, "/report"));
		await ctx.page.getByTestId("report-renderer-container").waitFor();
		await ctx.page.waitForTimeout(1500);
	},
	since: "v2.0.0",
};

export const keyboard: Scene = {
	about: "Keyboard use, visible focus and WCAG 2.1 AA (v3 accessibility work)",
	id: "keyboard",
	async run(ctx) {
		const { page } = ctx;
		const tab = async (n: number) => {
			for (let i = 0; i < n; i++) {
				await page.keyboard.press("Tab");
				await settle(ctx, 550);
			}
		};
		await ctx.say(
			{
				en: "You can use dembrane with only a keyboard. The outline shows where you are at every step.",
				nl: "Je kunt dembrane met alleen een toetsenbord gebruiken. De omlijning laat steeds zien waar je bent.",
			},
			() => tab(6),
		);
		await ctx.say(
			{
				en: "dembrane is tested against WCAG 2.1 AA, the accessibility guidelines. That includes contrast for text and controls, in light and dark mode.",
				nl: "dembrane is getest tegen WCAG 2.1 AA, de richtlijnen voor toegankelijkheid. Dat geldt ook voor het contrast van tekst en knoppen, in de lichte en de donkere modus.",
			},
			() => tab(5),
		);
	},
	async setup(ctx) {
		await ctx.page.goto(project(ctx, "/home"));
		await ctx.page.getByTestId("share-qr").waitFor();
		// Start just before the share buttons, so Tab walks the page rather than the sidebar.
		await ctx.page.getByTestId("share-copy-link").focus();
		await ctx.page.keyboard.press("Shift+Tab");
	},
	since: "v3.0.0",
	// The page's main column, enlarged so the focus outline reads on a phone screen too.
	zoom: { width: 1440, x: 410, y: 150 },
};
