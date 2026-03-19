const projectId = "project-e2e";
const chatId = "chat-e2e";
const runId = "run-e2e";
const directusBaseUrl = "http://localhost:8055";
const transcriptConversationId = "96adf4c3-290e-4eb6-876e-987610996fd5";
const transcriptChunkId = "chunk-e2e-1";

const project = {
	default_conversation_title: "Conversation",
	id: projectId,
	is_conversation_allowed: true,
	language: "en-US",
	name: "Agentic E2E Project",
	tags: [],
};

const chat = {
	chat_mode: "agentic",
	date_created: "2026-03-18T19:00:00.000Z",
	date_updated: "2026-03-18T19:00:00.000Z",
	id: chatId,
	name: "Agentic QA Chat",
	project_id: projectId,
};

const user = {
	disable_create_project: false,
	email: "agentic-e2e@dembrane.test",
	first_name: "Agentic",
	id: "user-e2e",
	legal_basis: null,
	privacy_policy_url: null,
	tfa_secret: null,
	whitelabel_logo: null,
};

const chatContext = {
	auto_select_bool: false,
	chat_mode: "agentic",
	conversation_id_list: [],
	conversations: [],
	locked_conversation_id_list: [],
	messages: [],
};

const extractToolQuery = (message) => {
	if (message.includes("Putin")) {
		return "Putin oligarch control loyalty sanctions wealth";
	}
	if (message.includes("clear sky")) return "clear sky sunny day";
	if (message.includes("comes after six")) return "comes after six";
	if (message.includes("opposite of cold")) return "opposite of cold";
	return "project conversations";
};

const buildToolStartPayload = (query) => ({
	data: {
		input: {
			conversation_id: transcriptConversationId,
			keywords: query,
			limit: 3,
		},
	},
	name: "grepConvoSnippets",
	run_id: `tool-${query}`,
});

const buildToolEndPayload = (query) => ({
	data: {
		input: {
			conversation_id: transcriptConversationId,
			keywords: query,
			limit: 3,
		},
		output: {
			kwargs: {
				content: JSON.stringify({
					conversation_id: transcriptConversationId,
					count: 1,
					matches: [
						{
							chunk_id: transcriptChunkId,
							snippet:
								"The discussion describes how wealth and political loyalty reinforce one another.",
						},
					],
					query,
				}),
			},
		},
	},
	name: "grepConvoSnippets",
	run_id: `tool-${query}`,
});

const nextTimestamp = (seq) =>
	new Date(Date.UTC(2026, 2, 18, 19, 0, seq)).toISOString();

describe("Agentic chat local smoke", () => {
	it("keeps tool rows compact, merges tool lifecycle rows, shows live status, renders transcript chips, scrolls to the newest reply, and restores history after reload", () => {
		let run = null;
		const events = [];
		let nextSeq = 0;
		let pendingTurn = null;
		let hydrateMode = false;

		const pushEvent = (eventType, payload) => {
			nextSeq += 1;
			const event = {
				event_type: eventType,
				id: nextSeq,
				payload,
				project_agentic_run_id: runId,
				seq: nextSeq,
				timestamp: nextTimestamp(nextSeq),
			};
			events.push(event);
			return event;
		};

		const buildReply = (message) => {
			if (message.includes("Putin")) {
				return `The transcript ties wealth to political loyalty [conversation_id:${transcriptConversationId};chunk_id:${transcriptChunkId}]`;
			}
			if (message.includes("clear sky")) return "blue";
			if (message.includes("comes after six")) return "seven";
			if (message.includes("opposite of cold")) return "hot";
			return "There are 0 conversations in this project.";
		};

		const beginTurn = (message) => {
			const query = extractToolQuery(message);
			const assistantReply = buildReply(message);
			pushEvent("user.message", { content: message });
			pushEvent("on_tool_start", buildToolStartPayload(query));
			pendingTurn = {
				assistantReply,
				query,
			};
			run = {
				completed_at: null,
				directus_user_id: user.id,
				id: runId,
				last_event_seq: nextSeq,
				latest_error: null,
				latest_error_code: null,
				latest_output: null,
				project_chat_id: chatId,
				project_id: projectId,
				started_at: nextTimestamp(1),
				status: "running",
			};
			return run;
		};

		const completeTurn = () => {
			if (!pendingTurn) return [];

			const streamedEvents = [
				pushEvent("on_tool_end", buildToolEndPayload(pendingTurn.query)),
				pushEvent("assistant.message", { content: pendingTurn.assistantReply }),
			];

			run = {
				...run,
				completed_at: nextTimestamp(nextSeq),
				last_event_seq: nextSeq,
				latest_output: pendingTurn.assistantReply,
				status: "completed",
			};
			pendingTurn = null;
			return streamedEvents;
		};

		cy.intercept("POST", `${directusBaseUrl}/auth/refresh*`, {
			body: {
				data: {
					access_token: "token-e2e",
					expires: 3600,
					refresh_token: "refresh-e2e",
				},
			},
			statusCode: 200,
		});

		cy.intercept("GET", `${directusBaseUrl}/users/me*`, {
			body: { data: user },
			statusCode: 200,
		});

		cy.intercept("GET", `${directusBaseUrl}/items/project/${projectId}*`, {
			body: { data: project },
			statusCode: 200,
		});

		cy.intercept("GET", `${directusBaseUrl}/items/project_chat/${chatId}*`, {
			body: { data: chat },
			statusCode: 200,
		});

		cy.intercept("GET", `${directusBaseUrl}/items/project_chat_message*`, {
			body: { data: [] },
			statusCode: 200,
		});

		cy.intercept("GET", `${directusBaseUrl}/items/project_chat*`, (req) => {
			if (Object.keys(req.query).some((key) => key.includes("aggregate"))) {
				req.reply({
					body: { data: [{ count: "1" }] },
					statusCode: 200,
				});
				return;
			}

			req.reply({
				body: { data: [chat] },
				statusCode: 200,
			});
		});

		cy.intercept("GET", `${directusBaseUrl}/items/conversation*`, (req) => {
			if (Object.keys(req.query).some((key) => key.includes("aggregate"))) {
				req.reply({
					body: { data: [{ count: "0" }] },
					statusCode: 200,
				});
				return;
			}

			req.reply({
				body: { data: [] },
				statusCode: 200,
			});
		});

		cy.intercept("GET", `${directusBaseUrl}/items/announcement*`, {
			body: { data: [] },
			statusCode: 200,
		});

		cy.intercept("GET", `${directusBaseUrl}/items/announcement_activity*`, {
			body: { data: [] },
			statusCode: 200,
		});

		cy.intercept("GET", `**/api/chats/${chatId}/context`, {
			body: chatContext,
			statusCode: 200,
		});

		cy.intercept("POST", "**/api/agentic/runs", (req) => {
			beginTurn(req.body.message);
			req.reply({
				body: run,
				statusCode: 200,
			});
		});

		cy.intercept("POST", `**/api/agentic/runs/${runId}/messages`, (req) => {
			beginTurn(req.body.message);
			req.reply({
				body: run,
				statusCode: 200,
			});
		});

		cy.intercept("GET", `**/api/agentic/runs/${runId}`, (req) => {
			req.reply({
				body: run ?? {
					completed_at: null,
					directus_user_id: user.id,
					id: runId,
					last_event_seq: 0,
					latest_error: null,
					latest_error_code: null,
					latest_output: null,
					project_chat_id: chatId,
					project_id: projectId,
					started_at: null,
					status: "completed",
				},
				delay: hydrateMode ? 250 : 0,
				statusCode: 200,
			});
		});

		cy.intercept("GET", `**/api/agentic/runs/${runId}/events*`, (req) => {
			const afterSeq = Number(req.query.after_seq ?? 0);
			const filteredEvents = events.filter((event) => event.seq > afterSeq);
			const pageSize = hydrateMode ? 3 : filteredEvents.length;
			const page = filteredEvents.slice(0, pageSize);
			const nextSeqValue =
				page.length > 0 ? page[page.length - 1].seq : afterSeq;

			req.reply({
				body: {
					done:
						page.length === 0 ||
						page[page.length - 1].seq === events[events.length - 1]?.seq,
					events: page,
					next_seq: nextSeqValue,
					run_id: runId,
					status: run?.status ?? "completed",
				},
				delay: hydrateMode ? 350 : 0,
				statusCode: 200,
			});
		});

		cy.intercept("POST", `**/api/agentic/runs/${runId}/stream*`, (req) => {
			const streamedEvents = completeTurn();
			const body = streamedEvents
				.map((event) => `event: message\ndata: ${JSON.stringify(event)}\n\n`)
				.join("");

			req.reply({
				body,
				delay: 400,
				headers: {
					"content-type": "text/event-stream",
				},
				statusCode: 200,
			});
		});

		cy.viewport(1440, 600);
		cy.visit(`/en-US/projects/${projectId}/chats/${chatId}`);

		cy.get('[data-testid="chat-interface"]').should("be.visible");
		cy.get('[data-testid="chat-title"]').should("contain.text", chat.name);

		cy.get('[data-testid="chat-input-textarea"]')
			.should("be.visible")
			.type(
				'Find the transcript excerpt about "Putin oligarch control loyalty sanctions wealth" and answer in one short sentence.',
			);
		cy.get('[data-testid="chat-send-button"]').click();

		cy.get('[data-testid="agentic-run-indicator"]')
			.should("be.visible")
			.and(
				"contain.text",
				'Search transcript for "Putin oligarch control loyalty sanctions wealth"',
			);
		cy.get('[data-testid^="agentic-tool-row-"]')
			.should("have.length", 1)
			.first()
			.then(($row) => {
				expect($row.outerHeight()).to.be.lessThan(96);
				expect($row.text()).to.include(
					'Search transcript for "Putin oligarch control loyalty sanctions wealth"',
				);
				expect($row.text()).not.to.include("Query:");
				expect($row.text()).not.to.include("Conversation:");
			});
		cy.contains("Raw data").should("not.exist");
		cy.get('[data-testid^="agentic-tool-raw-toggle-"]')
			.first()
			.click({ force: true });
		cy.get('[data-testid^="agentic-tool-raw-panel-"]')
			.first()
			.should("be.visible");
		cy.get('[data-testid="agentic-transcript-link"]', { timeout: 10000 })
			.should("be.visible")
			.and("contain.text", "transcript excerpt")
			.and("have.attr", "href")
			.and("include", `#chunk-${transcriptChunkId}`);
		cy.get('[data-testid="agentic-transcript-link"]')
			.first()
			.should("have.attr", "title", "Open transcript");
		cy.get('[data-testid="agentic-run-indicator"]').should("not.exist");
		cy.contains("The transcript ties wealth to political loyalty").should(
			"exist",
		);

		cy.get('[data-testid="chat-input-textarea"]')
			.clear()
			.type(
				"What color is a clear sky on a sunny day? Reply with one lowercase word only.",
			);
		cy.get('[data-testid="chat-send-button"]').click();
		cy.contains(/\bblue\b/).should("be.visible");

		cy.get('[data-testid="chat-input-textarea"]')
			.clear()
			.type("What comes after six? Reply with one lowercase word only.");
		cy.get('[data-testid="chat-send-button"]').click();
		cy.contains(/\bseven\b/).should("be.visible");

		cy.get('[data-testid="chat-input-textarea"]')
			.clear()
			.type(
				"What is the opposite of cold? Reply with one lowercase word only.",
			);
		cy.get('[data-testid="chat-send-button"]').click();
		cy.contains(/\bhot\b/)
			.should("be.visible")
			.then(($reply) => {
				const rect = $reply[0].getBoundingClientRect();
				expect(rect.bottom).to.be.lessThan(
					Cypress.config("viewportHeight") - 16,
				);
			});

		cy.get('[data-testid^="agentic-tool-row-"]')
			.its("length")
			.as("toolCountBefore");
		cy.then(() => {
			hydrateMode = true;
		});
		cy.reload();

		cy.get('[data-testid="chat-interface"]', { timeout: 60000 }).should(
			"be.visible",
		);
		cy.get('[data-testid="agentic-chat-loading"]', { timeout: 60000 }).should(
			"be.visible",
		);
		cy.get('[data-testid="agentic-chat-loading"]', { timeout: 60000 }).should(
			"not.exist",
		);
		cy.get('[data-testid="agentic-transcript-link"]', {
			timeout: 60000,
		}).should("be.visible");
		cy.contains("The transcript ties wealth to political loyalty", {
			timeout: 60000,
		}).should("be.visible");
		cy.contains(/\bblue\b/, { timeout: 60000 }).should("be.visible");
		cy.contains(/\bseven\b/, { timeout: 60000 }).should("be.visible");
		cy.contains(/\bhot\b/, { timeout: 60000 }).should("be.visible");
		cy.get("@toolCountBefore").then((toolCountBefore) => {
			cy.get('[data-testid^="agentic-tool-row-"]', { timeout: 60000 }).should(
				"have.length",
				toolCountBefore,
			);
		});
	});
});
