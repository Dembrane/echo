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
import type { PreviewMessage } from "@/lib/portalPreview/protocol";
import type { SectionKey } from "../portalForm";
import { PortalSectionEditor } from "./PortalSectionEditor";

const role = vi.hoisted(() => ({ current: "owner" }));
const emailFlag = vi.hoisted(() => ({ on: false }));
const updateMutateAsync = vi.hoisted(() => vi.fn(async () => ({})));
const editorReadOnly = vi.hoisted(() => [] as (boolean | undefined)[]);
const navigate = vi.hoisted(() => vi.fn());
const tracked = vi.hoisted(() => [] as [string, Record<string, unknown>][]);
const lastMessage = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));
vi.mock("@/lib/analytics/events", async (original) => ({
	...(await original<typeof import("@/lib/analytics/events")>()),
	track: (event: string, props: Record<string, unknown>) => {
		tracked.push([event, props]);
	},
}));
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
vi.mock("@/hooks/useI18nNavigate", () => ({ useI18nNavigate: () => navigate }));
vi.mock("@/components/project/hooks", () => ({
	useCreateCustomTopicMutation: () => ({
		isPending: false,
		mutateAsync: vi.fn(),
	}),
	useDeleteCustomTopicMutation: () => ({
		isPending: false,
		mutateAsync: vi.fn(),
	}),
	useProjectById: () => ({ data: { id: "p1", tags: [] } }),
	useUpdateCustomTopicMutation: () => ({
		isPending: false,
		mutateAsync: vi.fn(),
	}),
	useUpdateProjectByIdMutation: () => ({
		isPending: false,
		mutateAsync: updateMutateAsync,
	}),
}));
vi.mock("@/components/project/ProjectTagsInput", () => ({
	ProjectTagsInput: () => <div data-testid="tags-input" />,
}));
vi.mock("@/components/project/ProjectHostGuideLink", () => ({
	ProjectHostGuideLink: () => null,
}));
vi.mock("@/components/project/ProjectLegalBasisSection", () => ({
	ProjectLegalBasisSection: () => <div data-testid="legal-basis" />,
	useProjectLegalQuery: () => ({ data: undefined }),
}));
vi.mock("../preview/PortalPreviewFrame", () => ({
	PortalPreviewFrame: ({ message }: { message: PreviewMessage }) => {
		lastMessage.current = message;
		return <div data-testid="preview" data-screen={message.screen} />;
	},
}));
// The rich editor is not a native control, so it carries its own readOnly.
vi.mock("@/components/form/MarkdownWYSIWYG/MarkdownWYSIWYG", () => ({
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
	navigate.mockClear();
	tracked.length = 0;
	lastMessage.current = null;
});

beforeAll(() => {
	window.matchMedia =
		window.matchMedia ||
		((query: string) => ({
			addEventListener: () => {},
			addListener: () => {},
			dispatchEvent: () => false,
			matches: true,
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
	default_conversation_transcript_prompt: "Lindenwijk, Kastanjeplein",
	default_conversation_tutorial_slug: "none",
	get_reply_mode: "summarize",
	get_reply_prompt: "",
	id: "p1",
	is_get_reply_enabled: false,
	is_verify_enabled: false,
	language: "en",
	tags: [],
	updated_at: "2026-10-01T00:00:00Z",
	workspace_id: "w1",
} as unknown as Project;

const topic = (key: string, label: string, isCustom = false) => ({
	is_custom: isCustom,
	key,
	translations: { "en-US": { label } },
});

const renderPage = (
	section: SectionKey,
	option: string | undefined,
	overrides: Record<string, unknown> = {},
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
						<PortalSectionEditor
							project={{ ...project, ...overrides } as unknown as Project}
							section={section}
							option={option}
							readOnly={role.current === "observer"}
							tags={[]}
							verificationTopics={topics as never}
						/>
					</MemoryRouter>
				</MantineProvider>
			</I18nProvider>
		</QueryClientProvider>,
	);

// ECHO-1060: the one-page editor's behaviour, kept page by page.
describe("portal editor pages: permissions and saving", () => {
	it("observer gets a read-only page that never saves", () => {
		vi.useFakeTimers();
		role.current = "observer";
		renderPage("welcome", "description");
		expect(screen.getByTestId("portal-editor-form").hasAttribute("inert")).toBe(
			true,
		);
		expect(editorReadOnly.length).toBeGreaterThan(0);
		expect(editorReadOnly.every((r) => r === true)).toBe(true);
		fireEvent.click(screen.getAllByTestId("mdx-type")[0]);
		act(() => {
			vi.advanceTimersByTime(2000);
		});
		expect(updateMutateAsync).not.toHaveBeenCalled();
	});

	it.each(["member", "owner"])(
		"%s can edit; a page saves only its own values",
		async (r) => {
			vi.useFakeTimers();
			role.current = r;
			renderPage("welcome", "description");
			expect(
				screen.getByTestId("portal-editor-form").hasAttribute("inert"),
			).toBe(false);
			fireEvent.click(screen.getAllByTestId("mdx-type")[0]);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(2000);
			});
			expect(updateMutateAsync).toHaveBeenCalledTimes(1);
			const { payload } = (
				updateMutateAsync.mock.calls[0] as unknown as [{ payload: object }]
			)[0];
			expect(Object.keys(payload).sort()).toEqual(
				[
					"default_conversation_description",
					"default_conversation_title",
					"default_conversation_tutorial_slug",
				].sort(),
			);
			expect(payload).toMatchObject({
				default_conversation_description: "typed",
			});
			expect(tracked).toContainEqual([
				"portal_settings_saved",
				{
					fields_changed: ["default_conversation_description"],
					project_id: "p1",
				},
			]);
		},
	);

	it("the preview gets an unsaved value at once", () => {
		vi.useFakeTimers();
		renderPage("welcome", "title");
		fireEvent.change(screen.getByTestId("portal-editor-page-title-input"), {
			target: { value: "The square" },
		});
		expect(updateMutateAsync).not.toHaveBeenCalled();
		const message = lastMessage.current as PreviewMessage;
		expect(message.project.default_conversation_title).toBe("The square");
		expect(message.screen).toBe("recording");
		expect(message.highlight).toBe("title");
	});
});

describe("portal editor pages: stepping", () => {
	it("puts the open option in the address and steps with Next", () => {
		renderPage("welcome", undefined);
		// No option named: the first opens, and the address says so.
		expect(navigate).toHaveBeenCalledWith(
			"/w/w1/projects/p1/portal/welcome/language",
			{ replace: true },
		);
		cleanup();
		navigate.mockClear();
		renderPage("welcome", "language");
		fireEvent.click(screen.getByTestId("portal-option-next"));
		expect(navigate).toHaveBeenCalledWith(
			"/w/w1/projects/p1/portal/welcome/title",
			{ replace: true },
		);
		expect(tracked).toContainEqual([
			"portal_editor_option_stepped",
			{ option: "title", project_id: "p1", section: "welcome", via: "next" },
		]);
		expect(tracked).toContainEqual([
			"portal_editor_section_viewed",
			{ project_id: "p1", section: "welcome" },
		]);
	});

	it("the last option leads to the next page", () => {
		renderPage("welcome", "tutorial");
		fireEvent.click(screen.getByTestId("portal-option-next"));
		expect(navigate).toHaveBeenCalledWith("/w/w1/projects/p1/portal/privacy");
	});
});

// ECHO-1052, kept on the Verify and Explore pages.
describe("portal editor pages: Verify and Explore", () => {
	it("lists every Verify option with its one line, and the host's own topics", () => {
		renderPage(
			"verify",
			"topics",
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
		fireEvent.click(heard);
		expect(heard.checked).toBe(true);
		expect(screen.getAllByText("Our own check").length).toBeGreaterThan(0);
		// The host's own topics are edited on their own option.
		expect(
			screen.getByTestId("portal-option-custom-topics-summary").textContent,
		).toBe("Our own check");
	});

	it("shows the key terms read-only, with a way to Brief", () => {
		renderPage("verify", "key-terms", { is_verify_enabled: true });
		expect(
			screen.getByTestId("portal-editor-verify-key-terms").textContent,
		).toContain("Lindenwijk, Kastanjeplein");
		expect(
			screen
				.getByTestId("portal-editor-verify-key-terms-link")
				.getAttribute("href"),
		).toContain("/w/w1/projects/p1/brief#key-terms");
		expect(screen.queryByRole("textbox")).toBeNull();
	});

	it("shows cross-pollination with its line only when Explore is on", () => {
		renderPage("explore", "other-conversations", {
			is_get_reply_enabled: false,
		});
		expect(
			screen.queryByTestId("portal-editor-cross-pollination-switch"),
		).toBeNull();
		cleanup();
		renderPage("explore", "other-conversations", {
			is_get_reply_cross_pollination_enabled: false,
			is_get_reply_enabled: true,
		});
		expect(
			screen.getByTestId("portal-editor-cross-pollination-switch"),
		).toBeTruthy();
		expect(
			screen.getByText(
				"Explore may bring in what other groups in this project said. Off: it only looks at this conversation.",
			),
		).toBeTruthy();
		expect(screen.getByTestId("portal-option-mode-summary").textContent).toBe(
			"One question",
		);
	});
});

describe("portal editor pages: participant email flag", () => {
	it("off: hides asking for email and report notifications", () => {
		renderPage("about", "ask-email");
		expect(screen.queryByTestId("portal-editor-ask-email-checkbox")).toBeNull();
		cleanup();
		renderPage("finish", "notifications");
		expect(
			screen.queryByTestId("portal-editor-report-notifications"),
		).toBeNull();
	});

	it("off: still shows them on a project that has them on, to switch off", () => {
		const on = {
			default_conversation_ask_for_participant_email: true,
			is_project_notification_subscription_allowed: true,
		};
		renderPage("about", "ask-email", on);
		expect(screen.getByTestId("portal-editor-ask-email-checkbox")).toBeTruthy();
		cleanup();
		renderPage("finish", "notifications", on);
		expect(
			screen.getByTestId("portal-editor-report-notifications"),
		).toBeTruthy();
	});

	it("on: shows both as before", () => {
		emailFlag.on = true;
		renderPage("about", "ask-email");
		expect(screen.getByTestId("portal-editor-ask-email-checkbox")).toBeTruthy();
		cleanup();
		renderPage("finish", "notifications");
		expect(
			screen.getByTestId("portal-editor-report-notifications"),
		).toBeTruthy();
	});

	it("switching email off also switches report notifications off", () => {
		vi.useFakeTimers();
		renderPage("about", "ask-email", {
			default_conversation_ask_for_participant_email: true,
			is_project_notification_subscription_allowed: true,
		});
		fireEvent.click(screen.getByTestId("portal-editor-ask-email-checkbox"));
		act(() => {
			vi.advanceTimersByTime(2000);
		});
		expect(updateMutateAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				payload: expect.objectContaining({
					default_conversation_ask_for_participant_email: false,
					is_project_notification_subscription_allowed: false,
				}),
			}),
		);
	});
});

// ECHO-1053: the name box's label, under "Ask for name?".
describe("portal editor pages: name box label", () => {
	it("shows the label option only while asking for a name, with the default as placeholder", () => {
		renderPage("about", "name-label", {
			conversation_ask_for_participant_name_label: "Table name or number",
		});
		const input = screen.getByTestId(
			"portal-editor-name-label-input",
		) as HTMLInputElement;
		expect(input.value).toBe("Table name or number");
		expect(input.placeholder).toBe("Session name");
		expect(input.maxLength).toBe(80);
		cleanup();
		renderPage("about", "name-label", {
			default_conversation_ask_for_participant_name: false,
		});
		expect(screen.queryByTestId("portal-option-name-label")).toBeNull();
	});

	it("saves what the host types", () => {
		vi.useFakeTimers();
		renderPage("about", "name-label", {
			conversation_ask_for_participant_name_label: null,
		});
		const input = screen.getByTestId("portal-editor-name-label-input");
		expect((input as HTMLInputElement).value).toBe("");
		fireEvent.change(input, { target: { value: "Interview code" } });
		act(() => {
			vi.advanceTimersByTime(2000);
		});
		expect(updateMutateAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				payload: expect.objectContaining({
					conversation_ask_for_participant_name_label: "Interview code",
				}),
			}),
		);
	});
});
