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
const emailFlag = vi.hoisted(() => ({ on: false }));
const updateMutateAsync = vi.hoisted(() => vi.fn(async () => ({})));
const editorReadOnly = vi.hoisted(() => [] as (boolean | undefined)[]);

vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));
vi.mock("@/config", async (original) => ({
	...(await original<typeof import("@/config")>()),
	get ENABLE_PARTICIPANT_EMAIL() {
		return emailFlag.on;
	},
}));
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
	emailFlag.on = false;
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

const topic = (key: string, label: string, isCustom = false) => ({
	is_custom: isCustom,
	key,
	translations: { "en-US": { label } },
});

const renderWith = (
	overrides: Record<string, unknown>,
	topics = {
		available_topics: [] as ReturnType<typeof topic>[],
		selected_topics: [] as string[],
	},
) =>
	render(
		<QueryClientProvider client={new QueryClient()}>
			<I18nProvider i18n={i18n}>
				<MantineProvider>
					<MemoryRouter>
						<ProjectPortalEditor
							project={{ ...project, ...overrides } as unknown as Project}
							verificationTopics={topics as never}
						/>
					</MemoryRouter>
				</MantineProvider>
			</I18nProvider>
		</QueryClientProvider>,
	);

// ECHO-1052
describe("ProjectPortalEditor Verify and Explore", () => {
	it("lists every Verify option with its one line, and the host's own topics", () => {
		renderWith(
			{ is_verify_enabled: true },
			{
				available_topics: [
					topic("agreements", "Table check"),
					topic("disagreements", "Differences"),
					topic("actions", "Decisions and actions"),
					topic("gems", "Ideas worth keeping"),
					topic("truths", "Hard points"),
					topic("heard", "What we heard"),
					topic("moments", "Turning points"),
					topic("our-own-1234", "Our own check", true),
				],
				selected_topics: ["agreements"],
			},
		);
		for (const [key, line] of [
			["agreements", "What this group mostly agreed on, and what differed."],
			["disagreements", "Where views stayed different, each side in one line."],
			["actions", "Actions and proposals said out loud, and who was named."],
			["gems", "Ideas mentioned only briefly that could matter."],
			["truths", "Problems, risks or doubts the group named itself."],
			["heard", "What this person or group told us, in their own words."],
			["moments", "Moments where the group's view changed."],
		]) {
			const box = screen.getByTestId(`portal-editor-verify-topic-${key}`);
			// The line sits in the option's own box, under its label.
			const option = box.closest(".mantine-Checkbox-root")?.textContent ?? "";
			expect([key, option.includes(line)]).toEqual([key, true]);
		}
		const tableCheck = screen.getByTestId(
			"portal-editor-verify-topic-agreements",
		) as HTMLInputElement;
		expect(tableCheck.checked).toBe(true);
		const heard = screen.getByTestId(
			"portal-editor-verify-topic-heard",
		) as HTMLInputElement;
		expect(heard.checked).toBe(false);
		expect(screen.getByText("Our own check")).toBeTruthy();
		expect(screen.getByTestId("custom-topic-edit-our-own-1234")).toBeTruthy();
		fireEvent.click(heard);
		expect(heard.checked).toBe(true);
	});

	it("shows cross-pollination with its line only when Explore is on", () => {
		renderWith({ is_get_reply_enabled: false });
		expect(
			screen.queryByTestId("portal-editor-cross-pollination-switch"),
		).toBeNull();
		cleanup();
		renderWith({
			is_get_reply_cross_pollination_enabled: false,
			is_get_reply_enabled: true,
		});
		expect(
			screen.getByTestId("portal-editor-cross-pollination-switch"),
		).toBeTruthy();
		expect(screen.getByText("Cross-pollination")).toBeTruthy();
		expect(
			screen.getByText(
				"Explore may bring in what other groups in this project said. Off: it only looks at this conversation.",
			),
		).toBeTruthy();
		expect(screen.getByText("One question")).toBeTruthy();
	});
});

describe("ProjectPortalEditor participant email flag", () => {
	it("off: hides asking for email and report notifications", () => {
		renderWith({});
		expect(screen.queryByTestId("portal-editor-ask-email-checkbox")).toBeNull();
		expect(screen.queryByTestId("portal-editor-report-notifications")).toBeNull();
	});

	it("off: still shows them on a project that has them on, to switch off", () => {
		renderWith({
			default_conversation_ask_for_participant_email: true,
			is_project_notification_subscription_allowed: true,
		});
		expect(screen.getByTestId("portal-editor-ask-email-checkbox")).toBeTruthy();
		expect(
			screen.getByTestId("portal-editor-report-notifications"),
		).toBeTruthy();
	});

	it("on: shows both as before", () => {
		emailFlag.on = true;
		renderWith({});
		expect(screen.getByTestId("portal-editor-ask-email-checkbox")).toBeTruthy();
		expect(
			screen.getByTestId("portal-editor-report-notifications"),
		).toBeTruthy();
	});
});
