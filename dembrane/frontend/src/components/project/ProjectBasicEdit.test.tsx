// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { ProjectBasicEdit } from "./ProjectBasicEdit";

// The project's name and context save themselves a moment after an edit,
// once the edit is valid.
const mutateAsync = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("./hooks", () => ({
	useUpdateProjectByIdMutation: () => ({ mutateAsync }),
}));
vi.mock("@/lib/analytics/events", () => ({
	changedFields: () => [],
	track: vi.fn(),
}));

beforeAll(() => {
	i18n.loadAndActivate({ locale: "en-US", messages: {} });
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
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
});
afterEach(() => {
	cleanup();
	mutateAsync.mockClear();
});

const project = {
	context: "A town survey",
	id: "p1",
	name: "Town survey",
	updated_at: "2026-11-01T10:00:00.000Z",
} as unknown as Project;

const show = () =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider env="test">
				<MemoryRouter>
					<ProjectBasicEdit project={project} />
				</MemoryRouter>
			</MantineProvider>
		</I18nProvider>,
	);
const nameInput = () => screen.getByTestId("project-settings-name-input");
const contextInput = () => screen.getAllByRole("textbox")[1];

it("saves a new name a moment after it is typed", async () => {
	show();
	fireEvent.change(nameInput(), { target: { value: "Town survey 2027" } });
	expect(mutateAsync).not.toHaveBeenCalled();
	await waitFor(
		() =>
			expect(mutateAsync).toHaveBeenCalledWith({
				id: "p1",
				payload: { context: "A town survey", name: "Town survey 2027" },
			}),
		{ timeout: 3000 },
	);
});

it("saves the context too", async () => {
	show();
	fireEvent.change(contextInput(), { target: { value: "A city survey" } });
	await waitFor(
		() =>
			expect(mutateAsync).toHaveBeenCalledWith({
				id: "p1",
				payload: { context: "A city survey", name: "Town survey" },
			}),
		{ timeout: 3000 },
	);
});

it("saves no name that is too short, and says why", async () => {
	show();
	fireEvent.change(nameInput(), { target: { value: "ab" } });
	expect(
		await screen.findAllByText(
			"Project name must be at least 4 characters long",
		),
	).not.toHaveLength(0);
	await new Promise((resolve) => setTimeout(resolve, 1300));
	expect(mutateAsync).not.toHaveBeenCalled();
});
