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
import { ProjectKeyTermsSection } from "./ProjectKeyTermsSection";

// Key terms in the brief save themselves a moment after each change, typed
// or taken from a suggestion, and say so to analytics.
const state = vi.hoisted(() => ({
	mutateAsync: vi.fn(async (_vars: unknown) => ({})),
	track: vi.fn(),
}));
vi.mock("@/components/project/hooks", () => ({
	useUpdateProjectByIdMutation: () => ({ mutateAsync: state.mutateAsync }),
}));
vi.mock("@/lib/analytics/events", async (original) => ({
	...(await original<object>()),
	track: state.track,
}));
vi.mock("@/components/project/setup-suggestions/lazy", () => ({
	LazySuggestKeyTerms: ({
		value,
		onChange,
	}: {
		value: string;
		onChange: (v: string) => void;
	}) => (
		<button type="button" onClick={() => onChange(`${value}, Suggested`)}>
			Take suggestion
		</button>
	),
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
	state.mutateAsync.mockClear();
	state.track.mockClear();
});

const project = {
	default_conversation_transcript_prompt: "Dembrane",
	id: "p1",
	updated_at: "2026-11-01T10:00:00.000Z",
} as unknown as Project;

const show = (readOnly = false) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider env="test">
				<MemoryRouter>
					<ProjectKeyTermsSection project={project} readOnly={readOnly} />
				</MemoryRouter>
			</MantineProvider>
		</I18nProvider>,
	);
const addTerm = (term: string) => {
	const input = screen.getByTestId("portal-editor-specific-context-input");
	fireEvent.change(input, { target: { value: term } });
	fireEvent.keyDown(input, { key: "Enter" });
};
const savedWith = (terms: string) =>
	waitFor(
		() =>
			expect(state.mutateAsync).toHaveBeenCalledWith({
				id: "p1",
				payload: { default_conversation_transcript_prompt: terms },
			}),
		{ timeout: 3000 },
	);

it("saves a typed term a moment later, and counts the terms", async () => {
	show();
	addTerm("Amsterdam");
	expect(state.mutateAsync).not.toHaveBeenCalled();
	await savedWith("Dembrane, Amsterdam");
	await waitFor(() =>
		expect(state.track).toHaveBeenCalledWith("key_terms_updated", {
			count: 2,
			project_id: "p1",
			surface: "brief",
		}),
	);
});

it("saves a term taken from a suggestion", async () => {
	show();
	fireEvent.click(screen.getByRole("button", { name: "Take suggestion" }));
	await savedWith("Dembrane, Suggested");
});

it("saves nothing when read-only", async () => {
	show(true);
	fireEvent.click(screen.getByRole("button", { name: "Take suggestion" }));
	await new Promise((resolve) => setTimeout(resolve, 1300));
	expect(state.mutateAsync).not.toHaveBeenCalled();
});
