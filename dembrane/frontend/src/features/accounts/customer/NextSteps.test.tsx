// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, expect, it } from "vitest";
import type { DocumentSummaryT } from "../contract/contract.gen";
import * as fx from "../contract/fixtures.gen";
import { NextSteps } from "./NextSteps";

// The who-signs line on the to-do list: with someone named already, it says so instead of
// reading as two open questions.
beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
	window.matchMedia ??= ((query: string) => ({
		addEventListener: () => {},
		addListener: () => {},
		dispatchEvent: () => false,
		matches: false,
		media: query,
		onchange: null,
		removeEventListener: () => {},
		removeListener: () => {},
	})) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

const task = fx.whoSignsTask;
const show = (documents: DocumentSummaryT[]) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider env="test">
				<QueryClientProvider client={new QueryClient()}>
					<MemoryRouter>
						<NextSteps
							orgId={fx.accountPage.organisation.id}
							plan={{
								done: [],
								later: [],
								toDo: [task],
								toPay: [],
								waiting: [],
								withDpa: new Set(),
								withUs: [],
							}}
							documents={documents}
							today="2026-09-28"
							onBilling={() => {}}
							onBookCall={() => {}}
						/>
					</MemoryRouter>
				</QueryClientProvider>
			</MantineProvider>
		</I18nProvider>,
	);

it("with nobody named, the line counts the questions", () => {
	show(fx.accountPage.documents.map((d) => ({ ...d, signer: null })));
	expect(screen.getByTestId("task-fact").textContent).toBe("2 questions");
});

it("with someone named, the line says who signs the offer", () => {
	show(
		fx.accountPage.documents.map((d) =>
			d.id === task.document_id
				? {
						...d,
						signer: {
							email: "antoine@example-town.example",
							name: "Antoine Burgers",
							named_at: "2026-09-28T09:00:00.000Z",
							reminded_at: null,
							role: null,
						},
					}
				: d,
		),
	);
	expect(screen.getByTestId("task-fact").textContent).toBe(
		"Antoine Burgers is named to sign the offer.",
	);
});
