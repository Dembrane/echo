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
	waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route as Path, Routes } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { OnboardingRoute } from "./OnboardingRoute";

const { tracked, voice } = vi.hoisted(() => ({
	tracked: [] as { event: string; props: unknown }[],
	// The latest options the route passed to the voice hook, and a way to move its status.
	voice: {
		// One cancel for the whole file, so a test can see who released the voice.
		cancel: vi.fn(),
		errorKind: null as null | string,
		options: null as null | Record<string, unknown>,
		setStatus: (_s: "idle" | "recording" | "transcribing") => {},
	},
}));

vi.mock("@posthog/react", () => ({ usePostHog: () => null }));
vi.mock("@/lib/analytics/events", async (original) => ({
	...(await original<typeof import("@/lib/analytics/events")>()),
	track: (event: string, props?: unknown) => tracked.push({ event, props }),
}));
// The microphone is out of reach in jsdom: the hook is driven by hand.
vi.mock("@/components/voice/useVoiceTranscription", async () => {
	const { useState } = await import("react");
	return {
		useVoiceTranscription: (options: Record<string, unknown>) => {
			const [status, setStatus] = useState<
				"idle" | "recording" | "transcribing"
			>("idle");
			voice.options = options;
			voice.setStatus = setStatus;
			return {
				cancel: voice.cancel,
				dismissError: vi.fn(),
				elapsedMs: 0,
				errorCause: null,
				errorKind: voice.errorKind,
				isStarting: false,
				levels: [],
				start: vi.fn(),
				status,
				stop: vi.fn(),
			};
		},
	};
});

const QUESTION = "What problem are you trying to solve with dembrane?";
const PLACEHOLDER = "A sentence or two is plenty. Type it or record it.";
const VERSION = "26-nov-26";

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
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
	if (!globalThis.ResizeObserver) {
		globalThis.ResizeObserver = class {
			disconnect() {}
			observe() {}
			unobserve() {}
		} as unknown as typeof ResizeObserver;
	}
	globalThis.scrollTo = globalThis.scrollTo ?? (() => {});
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	tracked.length = 0;
	voice.options = null;
	voice.errorKind = null;
	voice.cancel.mockClear();
	try {
		window.sessionStorage.clear();
	} catch {}
});

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		status,
	});

// Onboarded but never answered: the route opens on the questions.
const stubFetch = () => {
	const answers: unknown[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("/v2/me"))
				return json(200, {
					has_legacy_projects: false,
					has_pending_invites: false,
					onboarding_answer_json: null,
					onboarding_completed: true,
				});
			if (url.endsWith("/user-settings/me"))
				return json(200, { first_name: "Nina" });
			if (url.endsWith("/v2/onboarding/answers")) {
				answers.push(JSON.parse(String(init?.body)));
				return json(200, { status: "success" });
			}
			return json(404, {});
		}),
	);
	return answers;
};

const renderRoute = () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<I18nProvider i18n={i18n}>
				<MantineProvider>
					<MemoryRouter initialEntries={["/en-US/onboarding"]}>
						<Routes>
							<Path
								path="/:language/onboarding"
								element={<OnboardingRoute />}
							/>
							<Path path="/:language/*" element={<p>home</p>} />
						</Routes>
					</MemoryRouter>
				</MantineProvider>
			</I18nProvider>
		</QueryClientProvider>,
	);
};

const button = (name: string) =>
	screen.getByRole("button", { name }) as HTMLButtonElement;

// "No" on risk, then "Within my organisation": the closed questions without training.
const answerClosedQuestions = async () => {
	fireEvent.click(await screen.findByLabelText("No"));
	fireEvent.click(button("Continue"));
	fireEvent.click(await screen.findByLabelText("Within my organisation"));
	fireEvent.click(button("Continue"));
	return (await screen.findByTestId(
		"onboarding-problem-message",
	)) as HTMLTextAreaElement;
};

const type = (box: HTMLTextAreaElement, value: string) =>
	fireEvent.change(box, { target: { value } });

const closedAnswers = [
	{ q1: ["within my organisation"] },
	{ q2: "no" },
	{ q3: "" },
];

it("after the closed questions the last screen asks the problem, with an empty box and Done disabled", async () => {
	stubFetch();
	renderRoute();
	const box = await answerClosedQuestions();
	expect(screen.getByText(QUESTION)).toBeTruthy();
	expect(box.tagName).toBe("TEXTAREA");
	expect(box.getAttribute("placeholder")).toBe(PLACEHOLDER);
	expect(box.getAttribute("aria-label")).toBe("Your answer");
	expect(box.getAttribute("maxlength")).toBe("5000");
	expect(screen.getByTestId("onboarding-problem-voice-record")).toBeTruthy();
	expect(button("Done").disabled).toBe(true);
	type(box, "   ");
	expect(button("Done").disabled).toBe(true);
	type(box, "We lose what people say");
	expect(button("Done").disabled).toBe(false);
});

it("the problem screen comes last after a yes on risk too", async () => {
	stubFetch();
	renderRoute();
	fireEvent.click(await screen.findByLabelText("Yes"));
	fireEvent.click(button("Continue"));
	// Training.
	fireEvent.click(await screen.findByLabelText("No"));
	fireEvent.click(button("Continue"));
	fireEvent.click(await screen.findByLabelText("Within my organisation"));
	expect(button("Continue")).toBeTruthy();
	fireEvent.click(button("Continue"));
	expect(await screen.findByTestId("onboarding-problem-message")).toBeTruthy();
	expect(screen.getByText(QUESTION)).toBeTruthy();
});

it("Done posts every answer with the problem trimmed, then leaves onboarding", async () => {
	const answers = stubFetch();
	renderRoute();
	const box = await answerClosedQuestions();
	type(box, "  We lose what people say in workshops.  ");
	fireEvent.click(button("Done"));
	await waitFor(() => expect(answers).toHaveLength(1));
	expect(answers[0]).toEqual({
		data: [...closedAnswers, { q4: "We lose what people say in workshops." }],
		skipped: false,
		version: VERSION,
	});
	await screen.findByText("home");
	const completed = tracked.filter(
		(e) => e.event === "onboarding_step_completed",
	);
	expect(completed.at(-1)?.props).toMatchObject({
		problem_answered: true,
		problem_voice_used: false,
		step: "questions",
	});
	// The text never goes to analytics.
	expect(JSON.stringify(tracked)).not.toContain("workshops");
});

it("Skip on the problem screen keeps the earlier answers without q4", async () => {
	const answers = stubFetch();
	renderRoute();
	const box = await answerClosedQuestions();
	type(box, "Typed, then skipped");
	fireEvent.click(button("Skip"));
	await waitFor(() => expect(answers).toHaveLength(1));
	expect(answers[0]).toEqual({
		data: closedAnswers,
		skipped: false,
		version: VERSION,
	});
	await screen.findByText("home");
	const completed = tracked.filter(
		(e) => e.event === "onboarding_step_completed",
	);
	expect(completed.at(-1)?.props).toMatchObject({
		problem_answered: false,
		step: "questions",
	});
});

it("Skip on the first screen still skips the whole step", async () => {
	const answers = stubFetch();
	renderRoute();
	await screen.findByLabelText("No");
	fireEvent.click(button("Skip"));
	await waitFor(() => expect(answers).toHaveLength(1));
	expect(answers[0]).toEqual({ data: [], skipped: true, version: VERSION });
});

it("voice transcribes for onboarding in the interface language, with no workspace or project", async () => {
	stubFetch();
	renderRoute();
	await answerClosedQuestions();
	expect(voice.options).toMatchObject({
		language: "en",
		purpose: "onboarding",
	});
	expect(voice.options?.workspaceId).toBeUndefined();
	expect(voice.options?.projectId).toBeUndefined();
});

it("a transcript is added after typed text and never replaces it", async () => {
	const answers = stubFetch();
	renderRoute();
	const box = await answerClosedQuestions();
	type(box, "I typed this.");
	act(() => {
		(voice.options?.onTranscript as (t: string) => void)(" And said this. ");
	});
	expect(box.value).toBe("I typed this. And said this.");
	act(() => {
		(voice.options?.onTranscript as (t: string) => void)("More.");
	});
	expect(box.value).toBe("I typed this. And said this. More.");
	fireEvent.click(button("Done"));
	await waitFor(() => expect(answers).toHaveLength(1));
	expect((answers[0] as { data: unknown[] }).data.at(-1)).toEqual({
		q4: "I typed this. And said this. More.",
	});
	const completed = tracked.filter(
		(e) => e.event === "onboarding_step_completed",
	);
	expect(completed.at(-1)?.props).toMatchObject({
		problem_answered: true,
		problem_voice_used: true,
	});
});

it("a transcript into an empty box fills it, and the merge is cut at 5000 characters", async () => {
	stubFetch();
	renderRoute();
	const box = await answerClosedQuestions();
	act(() => {
		(voice.options?.onTranscript as (t: string) => void)("Spoken only.");
	});
	expect(box.value).toBe("Spoken only.");
	expect(button("Done").disabled).toBe(false);
	type(box, "a".repeat(4990));
	act(() => {
		(voice.options?.onTranscript as (t: string) => void)("b".repeat(50));
	});
	expect(box.value).toHaveLength(5000);
	expect(box.value.startsWith("a".repeat(4990))).toBe(true);
});

it("Done waits while voice is recording or transcribing", async () => {
	stubFetch();
	renderRoute();
	const box = await answerClosedQuestions();
	type(box, "Something typed");
	expect(button("Done").disabled).toBe(false);
	act(() => voice.setStatus("recording"));
	expect(button("Done").disabled).toBe(true);
	expect(screen.getByTestId("onboarding-problem-voice-stop")).toBeTruthy();
	act(() => voice.setStatus("transcribing"));
	expect(button("Done").disabled).toBe(true);
	act(() => voice.setStatus("idle"));
	expect(button("Done").disabled).toBe(false);
});

it("Skip on the usage screen still skips the whole step", async () => {
	const answers = stubFetch();
	renderRoute();
	fireEvent.click(await screen.findByLabelText("No"));
	fireEvent.click(button("Continue"));
	await screen.findByLabelText("Within my organisation");
	fireEvent.click(button("Skip"));
	await waitFor(() => expect(answers).toHaveLength(1));
	expect(answers[0]).toEqual({ data: [], skipped: true, version: VERSION });
});

it("Skip on the training screen still skips the whole step", async () => {
	const answers = stubFetch();
	renderRoute();
	fireEvent.click(await screen.findByLabelText("Yes"));
	fireEvent.click(button("Continue"));
	await screen.findByText("Have you completed a training?");
	fireEvent.click(button("Skip"));
	await waitFor(() => expect(answers).toHaveLength(1));
	expect(answers[0]).toEqual({ data: [], skipped: true, version: VERSION });
});

it("the box is read-only while voice is recording or transcribing", async () => {
	stubFetch();
	renderRoute();
	const box = await answerClosedQuestions();
	expect(box.readOnly).toBe(false);
	act(() => voice.setStatus("recording"));
	expect(box.readOnly).toBe(true);
	act(() => voice.setStatus("transcribing"));
	expect(box.readOnly).toBe(true);
	act(() => voice.setStatus("idle"));
	expect(box.readOnly).toBe(false);
});

it("Back from the problem screen releases the voice", async () => {
	stubFetch();
	renderRoute();
	await answerClosedQuestions();
	voice.cancel.mockClear();
	fireEvent.click(button("Back"));
	expect(voice.cancel).toHaveBeenCalledTimes(1);
	expect(await screen.findByLabelText("Within my organisation")).toBeTruthy();
});

it("Skip on the problem screen releases the voice", async () => {
	const answers = stubFetch();
	renderRoute();
	await answerClosedQuestions();
	voice.cancel.mockClear();
	fireEvent.click(button("Skip"));
	expect(voice.cancel).toHaveBeenCalledTimes(1);
	await waitFor(() => expect(answers).toHaveLength(1));
});

it("Done releases the voice", async () => {
	const answers = stubFetch();
	renderRoute();
	const box = await answerClosedQuestions();
	type(box, "Something typed");
	voice.cancel.mockClear();
	fireEvent.click(button("Done"));
	expect(voice.cancel).toHaveBeenCalledTimes(1);
	await waitFor(() => expect(answers).toHaveLength(1));
});

it("a voice error shows under the box, above Skip and Done", async () => {
	stubFetch();
	voice.errorKind = "permission";
	renderRoute();
	const box = await answerClosedQuestions();
	const sentence = screen.getByText(
		"Your browser is blocking the microphone. Allow access, then try again.",
	);
	const follows = (a: Node, b: Node) =>
		Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
	expect(follows(box, sentence)).toBe(true);
	expect(follows(sentence, button("Skip"))).toBe(true);
	expect(follows(screen.getByText(QUESTION), box)).toBe(true);
});
