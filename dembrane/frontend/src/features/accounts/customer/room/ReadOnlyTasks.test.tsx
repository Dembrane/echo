// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { TaskT } from "../../contract/contract.gen";
import * as fx from "../../contract/fixtures.gen";

// What a room member sees of the tasks on the offer and the DPA: every one with its answer
// and review note, and nothing to press. New in this slice (dashboard-plan.md, unit 9):
// ./ReadOnlyTasks exports ReadOnlyTasks({ tasks, documents }).
const load = async () => (await import("./ReadOnlyTasks")).ReadOnlyTasks;

beforeAll(() => {
	i18n.load("en-US", {});
	i18n.activate("en-US");
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

const answered: TaskT = {
	...fx.signTask,
	code: null,
	id: "0199a1b9-0000-7000-8000-0000000000aa",
	kind: "upload",
	params: null,
	response_file_name: "collegebesluit.pdf",
	response_text: "Besluit van het college",
	review_note: "Graag de getekende versie",
	reviewed_at: "2026-09-29T10:00:00.000Z",
	status: "changes_requested",
	submitted_at: "2026-09-29T09:00:00.000Z",
	title: "Stuur ons het collegebesluit",
};

const show = async (tasks: TaskT[]) => {
	const ReadOnlyTasks = await load();
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider env="test">
				<MemoryRouter>
					<ReadOnlyTasks
						tasks={tasks}
						documents={fx.accountPage.documents.filter(
							(d) => d.kind !== "invoice",
						)}
					/>
				</MemoryRouter>
			</MantineProvider>
		</I18nProvider>,
	);
};

describe("the tasks, read only", () => {
	it("shows each task with its answer, its file's name and the review note", async () => {
		await show([fx.whoSignsTask, fx.signTask, answered]);
		const list = screen.getByTestId("room-tasks");
		expect(list.textContent).toContain("Stuur ons het collegebesluit");
		expect(list.textContent).toContain("Besluit van het college");
		expect(list.textContent).toContain("Graag de getekende versie");
		const file = within(list).getByText("collegebesluit.pdf");
		// The name only: no route serves a task's file to the customer side.
		expect(file.closest("a")).toBeNull();
		expect(document.querySelector('a[download], a[href*="file"]')).toBeNull();
	});

	it("offers nothing to answer, upload, sign or send", async () => {
		await show([fx.whoSignsTask, fx.signTask, answered]);
		const list = screen.getByTestId("room-tasks");
		expect(list.querySelector('input[type="file"]')).toBeNull();
		expect(list.querySelector("textarea")).toBeNull();
		expect(list.querySelector('[data-testid^="action-"]')).toBeNull();
		expect(within(list).queryAllByRole("button")).toHaveLength(0);
	});
});
