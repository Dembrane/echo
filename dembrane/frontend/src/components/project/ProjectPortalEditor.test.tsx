// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ProjectPortalEditor } from "./ProjectPortalEditor";

const role = vi.hoisted(() => ({ current: "owner" }));
const updateMutateAsync = vi.hoisted(() => vi.fn(async () => ({})));
const editorReadOnly = vi.hoisted(() => [] as (boolean | undefined)[]);

vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));
vi.mock("@/hooks/useWorkspace", () => ({
	useWorkspace: () => ({
		workspace: { id: "w1", role: role.current, tier: "innovator" },
	}),
}));
vi.mock("@/hooks/useLanguage", () => ({
	useLanguage: () => ({ iso639_1: "en", language: "en-US" }),
}));
vi.mock("./hooks", () => ({
	useCreateCustomTopicMutation: () => ({
		isPending: false,
		mutateAsync: vi.fn(),
	}),
	useDeleteCustomTopicMutation: () => ({
		isPending: false,
		mutateAsync: vi.fn(),
	}),
	useUpdateCustomTopicMutation: () => ({
		isPending: false,
		mutateAsync: vi.fn(),
	}),
	useUpdateProjectByIdMutation: () => ({
		isPending: false,
		mutateAsync: updateMutateAsync,
	}),
}));
vi.mock("./ProjectQRCode", () => ({ useProjectSharingLink: () => "" }));
vi.mock("./ProjectTagsInput", () => ({
	ProjectTagsInput: () => <div data-testid="tags-input" />,
}));
vi.mock("./ProjectHostGuideLink", () => ({ ProjectHostGuideLink: () => null }));
vi.mock("@/components/project/ProjectLegalBasisSection", () => ({
	ProjectLegalBasisSection: () => null,
}));
// The rich editor is not a native control, so it carries its own readOnly.
vi.mock("../form/MarkdownWYSIWYG/MarkdownWYSIWYG", () => ({
	MarkdownWYSIWYG: (props: {
		readOnly?: boolean;
		onChange?: (v: string) => void;
	}) => {
		editorReadOnly.push(props.readOnly);
		return (
			<button
				type="button"
				data-testid="mdx-type"
				onClick={() => props.onChange?.("typed")}
			>
				mdx
			</button>
		);
	},
}));

i18n.load("en-US", {});
i18n.activate("en-US");

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	role.current = "owner";
	updateMutateAsync.mockClear();
	editorReadOnly.length = 0;
});

beforeAll(() => {
	window.matchMedia =
		window.matchMedia ||
		((query: string) => ({
			addEventListener: () => {},
			addListener: () => {},
			dispatchEvent: () => false,
			matches: false,
			media: query,
			onchange: null,
			removeEventListener: () => {},
			removeListener: () => {},
		}));
	window.ResizeObserver =
		window.ResizeObserver ||
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		};
});

const project = {
	default_conversation_ask_for_participant_email: false,
	default_conversation_ask_for_participant_name: true,
	default_conversation_description: "Hello",
	default_conversation_finish_text: "Thanks",
	default_conversation_title: "Title",
	default_conversation_transcript_prompt: "",
	default_conversation_tutorial_slug: "none",
	get_reply_mode: "summarize",
	get_reply_prompt: "",
	id: "p1",
	is_get_reply_enabled: false,
	is_verify_enabled: false,
	language: "en",
	tags: [],
	updated_at: "2026-10-01T00:00:00Z",
} as unknown as Project;

const renderEditor = () =>
	render(
		<QueryClientProvider client={new QueryClient()}>
			<I18nProvider i18n={i18n}>
				<MantineProvider>
					<MemoryRouter>
						<ProjectPortalEditor
							project={project}
							verificationTopics={{ available_topics: [], selected_topics: [] }}
						/>
					</MemoryRouter>
				</MantineProvider>
			</I18nProvider>
		</QueryClientProvider>,
	);

describe("ProjectPortalEditor role gating", () => {
	it("observer gets a read-only editor that never saves", () => {
		vi.useFakeTimers();
		role.current = "observer";
		renderEditor();
		const language = screen.getByTestId("portal-editor-language-select");
		// Values stay visible.
		expect((language as HTMLSelectElement).value).toBe("en");
		expect(language.matches(":disabled")).toBe(true);
		expect(screen.getByTestId("portal-editor-form").hasAttribute("inert")).toBe(
			true,
		);
		expect(editorReadOnly.length).toBeGreaterThan(0);
		expect(editorReadOnly.every((r) => r === true)).toBe(true);
		// Even a change from a non-native control must not reach the API.
		fireEvent.click(screen.getAllByTestId("mdx-type")[0]);
		act(() => {
			vi.advanceTimersByTime(2000);
		});
		expect(updateMutateAsync).not.toHaveBeenCalled();
	});

	it.each(["member", "owner"])("%s can edit and autosaves", (r) => {
		vi.useFakeTimers();
		role.current = r;
		renderEditor();
		const language = screen.getByTestId("portal-editor-language-select");
		expect(language.matches(":disabled")).toBe(false);
		expect(
			screen.queryByTestId("portal-editor-form")?.hasAttribute("inert") ??
				false,
		).toBe(false);
		expect(editorReadOnly.every((v) => !v)).toBe(true);
		fireEvent.click(screen.getAllByTestId("mdx-type")[0]);
		act(() => {
			vi.advanceTimersByTime(2000);
		});
		expect(updateMutateAsync).toHaveBeenCalled();
	});
});
