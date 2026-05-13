import { loginToApp, logout } from "../../support/functions/login";
import { openPortalEditor } from "../../support/functions/portal";
import { createProject, deleteProject } from "../../support/functions/project";
import { openSettingsMenu } from "../../support/functions/settings";

describe("Live Signposts", () => {
	const directusUrl = (Cypress.env("directusUrl") || "http://localhost:8055").replace(
		/\/$/,
		"",
	);
	let projectId;
	let locale = "en-US";

	const getAuthCredentials = () => {
		const auth = Cypress.env("auth") || {};
		if (!auth.email || !auth.password) {
			throw new Error(
				"Missing Directus credentials. Set CYPRESS_EMAIL and CYPRESS_PASSWORD.",
			);
		}
		return auth;
	};

	const getFocusTermsTextarea = () =>
		cy
			.get('[data-testid="portal-editor-signposting-focus-terms-textarea"]')
			.then(($element) => {
				const $textarea = $element.is("textarea")
					? $element
					: $element.find("textarea").first();
				return cy.wrap($textarea);
			});

	const toggleLiveSignposting = (enable = true) => {
		cy.get('[data-testid="portal-editor-signposting-switch"]')
			.scrollIntoView()
			.should("exist")
			.then(($input) => {
				const $label = $input.closest("label");
				const isChecked = $input.is(":checked");

				if ((enable && !isChecked) || (!enable && isChecked)) {
					cy.wrap($label).click({ force: true });
				}
			});

		cy.get('[data-testid="portal-editor-signposting-switch"]').should(
			enable ? "be.checked" : "not.be.checked",
		);
	};

	const loginToDirectus = () => {
		const auth = getAuthCredentials();
		return cy
			.request("POST", `${directusUrl}/auth/login`, {
				email: auth.email,
				password: auth.password,
			})
			.its("body.data.access_token");
	};

	afterEach(() => {
		if (projectId) {
			cy.visit(`/${locale}/projects/${projectId}/overview`);
			deleteProject(projectId);
		}

		cy.get("body").then(($body) => {
			const hasSettingsButton =
				$body.find('[data-testid="header-settings-gear-button"]:visible').length > 0;
			const hasLogoutButton =
				$body.find('[data-testid="header-logout-menu-item"]:visible').length > 0;

			if (hasSettingsButton) {
				openSettingsMenu();
				logout();
			} else if (hasLogoutButton) {
				logout();
			}
		});

		projectId = undefined;
		locale = "en-US";
	});

	const seedConversationWithSignposts = ({ locale, projectId }) => {
		const suffix = Cypress._.random(1000, 9999);
		const signpostTitle = `Transit affordability ${suffix}`;
		const signpostSummary =
			"Participants keep returning to the rising cost of buses and trains.";
		const signpostQuote = "Public transport is becoming too expensive for families.";

		return loginToDirectus().then((accessToken) => {
			const headers = {
				Authorization: `Bearer ${accessToken}`,
			};

			return cy
				.request({
					body: {
						is_finished: false,
						participant_name: `Signpost Participant ${suffix}`,
						project_id: projectId,
						source: "PORTAL_TEXT",
					},
					headers,
					method: "POST",
					url: `${directusUrl}/items/conversation`,
				})
				.then((conversationResponse) => {
					const conversationId = conversationResponse.body.data.id;
					const timestamp = new Date().toISOString();

					return cy
						.request({
							body: {
								conversation_id: conversationId,
								signpost_processed_at: timestamp,
								signpost_ready_at: timestamp,
								source: "PORTAL_TEXT",
								timestamp,
								transcript:
									"People agree that public transport costs are rising quickly.",
							},
							headers,
							method: "POST",
							url: `${directusUrl}/items/conversation_chunk`,
						})
						.then((chunkResponse) => {
							const chunkId = chunkResponse.body.data.id;

							return cy
								.request({
									body: {
										category: "theme",
										confidence: 0.92,
										conversation_id: conversationId,
										evidence_chunk_id: chunkId,
										evidence_quote: signpostQuote,
										status: "active",
										summary: signpostSummary,
										title: signpostTitle,
									},
									headers,
									method: "POST",
									url: `${directusUrl}/items/conversation_signpost`,
								})
								.then((signpostResponse) => ({
									conversationId,
									locale,
									projectId,
									signpostId: signpostResponse.body.data.id,
									signpostQuote,
									signpostSummary,
									signpostTitle,
								}));
						});
				});
		});
	};

	it("shows seeded signposts in portal settings, conversation overview, and host guide", () => {
		loginToApp();
		createProject();

		cy.location("pathname").then((pathname) => {
			const segments = pathname.split("/").filter(Boolean);
			projectId = segments[segments.indexOf("projects") + 1];
			locale = segments[0] || locale;
		});

		openPortalEditor();
		toggleLiveSignposting(true);
		cy.intercept("PATCH", `${directusUrl}/items/project/*`, (req) => {
			const focusTerms = req.body?.signposting_focus_terms;
			if (
				typeof focusTerms === "string" &&
				focusTerms.includes("public transport")
			) {
				req.alias = "saveSignpostingFocusTerms";
			}
		});
		getFocusTermsTextarea()
			.scrollIntoView()
			.clear()
			.type("affordability{enter}public transport");
		cy.wait("@saveSignpostingFocusTerms");

		cy.reload();
		openPortalEditor();
		cy.get('[data-testid="portal-editor-signposting-switch"]').should("be.checked");
		getFocusTermsTextarea().should(
			"have.value",
			"affordability\npublic transport",
		);

		cy.then(() => seedConversationWithSignposts({ locale, projectId })).then(
			({ conversationId, signpostId, signpostQuote, signpostSummary, signpostTitle }) => {
				cy.visit(
					`/${locale}/projects/${projectId}/conversation/${conversationId}/overview`,
				);

				cy.get('[data-testid="conversation-signposts-section"]', {
					timeout: 20000,
				}).should("be.visible");
				cy.get(`[data-testid="conversation-signpost-card-${signpostId}"]`)
					.should("contain.text", signpostTitle)
					.and("contain.text", signpostSummary)
					.and("contain.text", signpostQuote);

				cy.visit(`/${locale}/projects/${projectId}/host-guide`);

				cy.get('[data-testid="host-guide-live-signposts-panel"]', {
					timeout: 30000,
				}).should("be.visible");
				cy.get(`[data-testid="host-guide-live-signpost-${signpostId}"]`, {
					timeout: 30000,
				})
					.should("contain.text", signpostTitle)
					.and("contain.text", signpostSummary);
			},
		);
	});
});
