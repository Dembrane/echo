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
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { BookingLinks } from "@/lib/links";
import {
	type Answers,
	CONFIG_STORAGE_KEY,
	readStoredConfiguration,
} from "./configuratorState";
import { PricingConfigurator } from "./PricingConfigurator";
import {
	ANSWER_KEYS,
	getQuestionSet,
	QUESTION_KEYS,
	QUESTION_SET_VERSION,
	STEP_COUNT,
} from "./questions";
import type { SubmitConfiguration } from "./submitConfiguration";

/** The one feature flag this component reads. Nothing else in the frontend
 * reads one, so the flag is mocked here rather than through a helper. */
const flag = vi.hoisted(() => ({
	payload: undefined as unknown,
	value: undefined as string | undefined,
}));

vi.mock("posthog-js", () => ({
	default: {
		capture: () => {},
		getFeatureFlag: () => flag.value,
		getFeatureFlagPayload: () => flag.payload,
		onFeatureFlags: () => () => {},
	},
}));

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");

	// MantineProvider reads the OS color scheme on mount; jsdom has no
	// matchMedia, so stub a minimal (always non-matching) implementation.
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

beforeEach(() => {
	sessionStorage.clear();
	flag.value = undefined;
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	// The booking step looks for these two. Neither may outlive a test.
	(globalThis as { Cal?: unknown }).Cal = undefined;
	for (const script of document.querySelectorAll(
		`script[src="${BookingLinks.EMBED_SCRIPT}"]`,
	)) {
		script.remove();
	}
});

const LocationProbe = () => {
	const location = useLocation();
	return <div data-testid="location">{location.search}</div>;
};

/** Stands in for the browser back button. `navigate(-1)` is what the button
 * does, so this is the real behaviour and not a simulation of it. */
const HistoryBack = () => {
	const navigate = useNavigate();
	return (
		<button
			data-testid="history-back"
			onClick={() => navigate(-1)}
			type="button"
		>
			back
		</button>
	);
};

/** A typed stand in for the endpoint that `answers-stored` still owns. */
const submitMock = () => vi.fn<SubmitConfiguration>();

const seed = (answers: Answers, sessionId = "session-under-test") => {
	sessionStorage.setItem(
		CONFIG_STORAGE_KEY,
		JSON.stringify({
			answers,
			config_session_id: sessionId,
			furthest_step: 1,
			question_set_version: QUESTION_SET_VERSION,
		}),
	);
};

const renderConfigurator = ({
	entries = ["/workspace"],
	projectId,
	submit = submitMock().mockResolvedValue({ reference: "DEM-4F2A" }),
	wallKey,
}: {
	entries?: string[];
	projectId?: string;
	submit?: ReturnType<typeof submitMock>;
	wallKey?: string;
} = {}) => {
	const onClose = vi.fn();
	const onEvent = vi.fn();
	const view = render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<MemoryRouter initialEntries={entries}>
					<LocationProbe />
					<HistoryBack />
					<PricingConfigurator
						onClose={onClose}
						onEvent={onEvent}
						opened
						projectId={projectId}
						submit={submit}
						wallKey={wallKey}
					/>
				</MemoryRouter>
			</MantineProvider>
		</I18nProvider>,
	);
	return { onClose, onEvent, submit, view };
};

const search = () => screen.getByTestId("location").textContent;
const next = () =>
	fireEvent.click(screen.getByTestId("pricing-configurator-next"));
const modalText = () =>
	screen.getByTestId("pricing-configurator-modal").textContent ?? "";

// 1. The question list is one typed list with a version, in a fixed order.

it("keeps the five questions in order behind the opening, with a version", () => {
	expect(QUESTION_SET_VERSION).toBe("21-aug-26");
	// Six steps, and the first one is the opening.
	expect(STEP_COUNT).toBe(6);
	expect([...QUESTION_KEYS]).toEqual([
		"use_case",
		"timing",
		"volume",
		"concurrency",
		"extras",
	]);
	// `context` shares the last step, so it answers without being a step.
	expect([...ANSWER_KEYS]).toEqual([...QUESTION_KEYS, "context"]);

	const questions = getQuestionSet();
	expect(questions.map((question) => question.key)).toEqual([...QUESTION_KEYS]);
	expect(questions[0].label).toBe("What do you want to use dembrane for?");
	expect(questions[0].hint).toBe("Tick anything that fits.");
	expect(questions[2].label).toBe(
		"How many recordings do you expect in your first year?",
	);
	expect(questions[3].label).toBe(
		"At your busiest moment, how many conversations will be running at once?",
	);
});

it("carries the volume buckets and the two extras, with the free text merged in", () => {
	const [, , volume, , extras] = getQuestionSet();
	if (volume.kind === "text" || extras.kind === "text") {
		throw new Error("volume and extras are option questions");
	}

	expect(volume.options.map((option) => option.key)).toEqual([
		"under_50",
		"50_to_250",
		"250_to_1000",
		"over_1000",
		"not_sure",
	]);
	expect(volume.options.map((option) => option.label)).toEqual([
		"Under 50.",
		"50 to 250.",
		"250 to 1000.",
		"More than 1000.",
		"Not sure yet.",
	]);

	expect(extras.options.map((option) => option.key)).toEqual([
		"event_help",
		"procurement_help",
	]);
	// Help, not upsell: no price talk inside the options, and training is gone.
	expect(
		extras.options.map((option) => option.description).join(" "),
	).not.toMatch(/price|training/i);

	// The old sixth question is gone. Its free text now shares this step.
	expect(extras.follow?.key).toBe("context");
	expect(extras.follow?.label).toBe("Anything else you'd like to share");
	expect(extras.follow?.examples).toHaveLength(4);
});

it("opens a free text box on Something else, and a number box above 40", () => {
	const [useCase, timing, , concurrency] = getQuestionSet();
	if (useCase.kind === "text" || concurrency.kind === "text") {
		throw new Error("use case and concurrency are option questions");
	}
	expect(useCase.options.map((option) => option.key)).toEqual([
		"event_workshop",
		"assembly",
		"conference_sessions",
		"in_person",
		"audio_survey",
		"something_else",
	]);
	expect(useCase.options.at(-1)?.reveals).toBe("text");
	expect(
		concurrency.options.find((option) => option.key === "more_than_40")
			?.reveals,
	).toBe("number");

	// Timing moved up to the first question after the opening, examples intact.
	expect(timing.kind).toBe("text");
	if (timing.kind !== "text") return;
	expect(timing.examples).toHaveLength(6);
	expect(timing.examples?.[1].label).toBe("Six weekends across seven months");
});

// 2. The opening is step 1, and it names what the person was trying to do.

it("opens on step 1 of 6 with the line for the wall they met", async () => {
	renderConfigurator({ wallKey: "upload_cap" });

	await waitFor(() => expect(search()).toBe("?pc_step=1"));
	expect(screen.getByTestId("pricing-configurator-opening").textContent).toBe(
		"You were trying to upload recordings.",
	);
	expect(modalText()).toContain("Step 1 of 6");
	expect(modalText()).toContain(
		"That requires a paid plan. We're going to ask you 5 more quick questions",
	);
	// No question yet: the opening IS step 1.
	expect(screen.queryByTestId("pricing-option-use_case-assembly")).toBeNull();
	expect(screen.getByTestId("pricing-configurator-next").textContent).toBe(
		"Continue",
	);
	expect(screen.getByTestId("pricing-configurator-not-now")).toBeTruthy();
});

it("gives each wall its own first line and the same words under it", async () => {
	const first = renderConfigurator({ wallKey: "webhooks" });
	await waitFor(() => expect(search()).toBe("?pc_step=1"));
	const webhooks = modalText();
	expect(screen.getByTestId("pricing-configurator-opening").textContent).toBe(
		"You were trying to use webhooks.",
	);
	first.view.unmount();
	cleanup();

	renderConfigurator({ wallKey: "custom_logo" });
	await waitFor(() => expect(search()).toBe("?pc_step=1"));
	expect(screen.getByTestId("pricing-configurator-opening").textContent).toBe(
		"You were trying to add your logo.",
	);
	// One line differs and nothing else does. The modal still names no feature
	// under it and no tier anywhere.
	expect(modalText().replace("add your logo", "use webhooks")).toBe(webhooks);
	expect(modalText()).not.toMatch(/changemaker|innovator|guardian/i);
});

it("says you are on the free plan where there is no wall", async () => {
	// The billing page is not a wall: nothing is blocked, so nobody was stopped.
	renderConfigurator({ wallKey: "billing_page" });
	await waitFor(() => expect(search()).toBe("?pc_step=1"));
	expect(screen.getByTestId("pricing-configurator-opening").textContent).toBe(
		"You are on the free plan.",
	);

	cleanup();

	// And a mount that names no wall at all reads the same way.
	renderConfigurator();
	await waitFor(() => expect(search()).toBe("?pc_step=1"));
	expect(screen.getByTestId("pricing-configurator-opening").textContent).toBe(
		"You are on the free plan.",
	);
});

it("numbers the first question as step 2, so step_viewed starts there", async () => {
	const { onEvent } = renderConfigurator({ wallKey: "report_cap" });
	await waitFor(() => expect(search()).toBe("?pc_step=1"));
	next();
	await waitFor(() => expect(search()).toBe("?pc_step=2"));

	const viewed = onEvent.mock.calls
		.filter(([name]) => name === "pricing_config_step_viewed")
		.map(([, props]) => props);
	// The opening carries no question, so it carries no step_key.
	expect(viewed[0]).toMatchObject({ step: 1 });
	expect(viewed[0].step_key).toBeUndefined();
	// The first question is step 2, which is where question numbering starts.
	expect(viewed.find((props) => props.step === 2)).toMatchObject({
		step_key: "use_case",
	});
	expect(
		viewed.some((props) => props.step_key === "use_case" && props.step !== 2),
	).toBe(false);
	expect(modalText()).toContain("Step 2 of 6");
});

// 3. The step is a value in the URL, and back undoes a step.

it("puts the step in the url and lets the back button undo one", async () => {
	renderConfigurator();

	await waitFor(() => expect(search()).toBe("?pc_step=1"));

	next();
	await waitFor(() => expect(search()).toBe("?pc_step=2"));
	next();
	await waitFor(() => expect(search()).toBe("?pc_step=3"));

	fireEvent.click(screen.getByTestId("history-back"));
	await waitFor(() => expect(search()).toBe("?pc_step=2"));
	fireEvent.click(screen.getByTestId("history-back"));
	await waitFor(() => expect(search()).toBe("?pc_step=1"));
});

it("closes rather than leaving the page when back is pressed on the opening", async () => {
	const { onClose } = renderConfigurator();
	await waitFor(() => expect(search()).toBe("?pc_step=1"));

	fireEvent.click(screen.getByTestId("history-back"));

	await waitFor(() => expect(onClose).toHaveBeenCalled());
});

it("keeps the step already in the url on a reload", async () => {
	renderConfigurator({ entries: ["/workspace?pc_step=3"] });
	await waitFor(() =>
		expect(screen.getByTestId("pricing-timing-input")).toBeTruthy(),
	);
	expect(search()).toBe("?pc_step=3");
});

// 4. Nothing is required, and skip is a real button from the second question on.

it("offers Not now through the first question and a real Skip after it", async () => {
	renderConfigurator();
	await waitFor(() => expect(search()).toBe("?pc_step=1"));

	// The opening.
	expect(screen.getByTestId("pricing-configurator-not-now")).toBeTruthy();
	expect(screen.queryByTestId("pricing-configurator-skip")).toBeNull();
	next();

	// The first question keeps "Not now" and "Let's go!".
	await waitFor(() => expect(search()).toBe("?pc_step=2"));
	expect(screen.getByTestId("pricing-configurator-not-now")).toBeTruthy();
	expect(screen.queryByTestId("pricing-configurator-skip")).toBeNull();
	expect(screen.getByTestId("pricing-configurator-next").textContent).toBe(
		"Let's go!",
	);
	next();

	// Back, Skip and Next from here on.
	for (const step of [3, 4, 5]) {
		await waitFor(() => expect(search()).toBe(`?pc_step=${step}`));
		expect(screen.getByTestId("pricing-configurator-back")).toBeTruthy();
		expect(screen.getByTestId("pricing-configurator-skip")).toBeTruthy();
		expect(screen.getByTestId("pricing-configurator-next").textContent).toBe(
			"Next",
		);
		fireEvent.click(screen.getByTestId("pricing-configurator-skip"));
	}

	await waitFor(() => expect(search()).toBe("?pc_step=6"));
	// The last step sends, so there is nothing left to skip past.
	expect(screen.queryByTestId("pricing-configurator-skip")).toBeNull();
	expect(screen.getByTestId("pricing-configurator-next").textContent).toBe(
		"Next: pick a time",
	);
});

it("sends with every field empty, because nothing is required", async () => {
	const submit = submitMock().mockResolvedValue({ reference: "DEM-0000" });
	renderConfigurator({ entries: ["/workspace?pc_step=6"], submit });

	await waitFor(() =>
		expect(screen.getByTestId("pricing-context-input")).toBeTruthy(),
	);
	next();

	await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
	expect(submit.mock.calls[0][0].config.answered).toBe(0);
	expect(submit.mock.calls[0][0].status).toBe("submitted");
});

// 5. A reload restores the answers and the same session id.

it("restores the answers and the same session id after a reload", async () => {
	const first = renderConfigurator({ entries: ["/workspace?pc_step=2"] });
	await waitFor(() => expect(search()).toBe("?pc_step=2"));

	fireEvent.click(screen.getByTestId("pricing-option-use_case-event_workshop"));
	await waitFor(() =>
		expect(readStoredConfiguration()?.answers.use_case).toEqual([
			"event_workshop",
		]),
	);
	const sessionId = readStoredConfiguration()?.config_session_id;
	expect(sessionId).toBeTruthy();

	// The reload: the tree goes, session storage stays.
	first.view.unmount();
	cleanup();

	const submit = submitMock().mockResolvedValue({ reference: "DEM-4F2A" });
	renderConfigurator({ entries: ["/workspace?pc_step=2"], submit });

	const restored = (await screen.findByTestId(
		"pricing-option-use_case-event_workshop",
	)) as HTMLInputElement;
	expect(restored.checked).toBe(true);
	expect(readStoredConfiguration()?.config_session_id).toBe(sessionId);
});

it("carries the restored session id onto the send", async () => {
	seed({ context: "a citizens assembly" }, "session-under-test");
	const submit = submitMock().mockResolvedValue({ reference: "DEM-4F2A" });
	renderConfigurator({ entries: ["/workspace?pc_step=6"], submit });

	await waitFor(() =>
		expect(screen.getByTestId("pricing-context-input")).toBeTruthy(),
	);
	next();

	await waitFor(() => expect(submit).toHaveBeenCalled());
	expect(submit.mock.calls[0][0].config_session_id).toBe("session-under-test");
	expect(submit.mock.calls[0][0].answers_raw.context).toBe(
		"a citizens assembly",
	);
});

// 6. A failed send keeps the answers on screen and offers one retry.

it("keeps the answers on screen when the send fails, and the retry is the same button", async () => {
	seed({ context: "forty people in one room" });
	const submit = submitMock()
		.mockRejectedValueOnce(new Error("network down"))
		.mockResolvedValueOnce({ reference: "DEM-4F2A" });
	const { onEvent } = renderConfigurator({
		entries: ["/workspace?pc_step=6"],
		submit,
	});

	const box = await screen.findByTestId("pricing-context-input");
	next();

	await waitFor(() =>
		expect(screen.getByTestId("pricing-configurator-send-failed")).toBeTruthy(),
	);
	// The answers stay exactly where they were.
	expect((box as HTMLTextAreaElement).value).toBe("forty people in one room");
	expect(search()).toBe("?pc_step=6");
	expect(
		onEvent.mock.calls.some(
			([name, props]) =>
				name === "pricing_config_submit_failed" && props.attempt === 1,
		),
	).toBe(true);

	// One retry, and it is the primary button, so there is no second one to find.
	expect(screen.getAllByTestId("pricing-configurator-next")).toHaveLength(1);
	next();

	await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
	await waitFor(() => expect(search()).toBe("?pc_step=book"));
});

// 7. Every step is reachable with the keyboard alone.

it("moves focus to the heading on every step, the opening included", async () => {
	renderConfigurator({ wallKey: "transcripts_view" });

	await waitFor(() =>
		expect(document.activeElement?.textContent).toBe(
			"You were trying to see transcripts.",
		),
	);

	next();
	await waitFor(() =>
		expect(document.activeElement?.textContent).toBe(
			"What do you want to use dembrane for?",
		),
	);
	expect((document.activeElement as HTMLElement).tabIndex).toBe(-1);
});

it("labels every control and never forces a tab order", async () => {
	renderConfigurator();
	const modal = await screen.findByTestId("pricing-configurator-modal");

	for (const step of [1, 2, 3, 4, 5, 6]) {
		await waitFor(() => expect(search()).toBe(`?pc_step=${step}`));

		for (const element of modal.querySelectorAll("[tabindex]")) {
			expect(Number(element.getAttribute("tabindex"))).toBeLessThanOrEqual(0);
		}
		for (const control of modal.querySelectorAll<HTMLElement>(
			"input, textarea",
		)) {
			const labelled =
				control.getAttribute("aria-label") ??
				control.getAttribute("aria-labelledby") ??
				(control.id
					? modal.querySelector(`label[for="${control.id}"]`)?.textContent
					: null);
			expect(labelled).toBeTruthy();
			expect(control.hasAttribute("disabled")).toBe(false);
		}

		if (step < STEP_COUNT) next();
	}
});

it("advances on Enter in a free text answer, so the keyboard alone gets through", async () => {
	renderConfigurator({ entries: ["/workspace?pc_step=3"] });

	const box = await screen.findByTestId("pricing-timing-input");
	fireEvent.change(box, {
		target: { value: "six weekends across seven months" },
	});
	fireEvent.keyDown(box, { key: "Enter" });

	await waitFor(() => expect(search()).toBe("?pc_step=4"));
	expect(readStoredConfiguration()?.answers.timing).toBe(
		"six weekends across seven months",
	);
});

it("keeps a newline on shift and Enter rather than advancing", async () => {
	renderConfigurator({ entries: ["/workspace?pc_step=6"] });

	const box = await screen.findByTestId("pricing-context-input");
	fireEvent.keyDown(box, { key: "Enter", shiftKey: true });

	expect(search()).toBe("?pc_step=6");
});

// The three free text boxes, and the two controls an option reveals.

it("gives all three free text answers the composer with voice", async () => {
	renderConfigurator({ entries: ["/workspace?pc_step=2"], projectId: "p-1" });

	// The first question, behind Something else.
	await waitFor(() => expect(search()).toBe("?pc_step=2"));
	expect(screen.queryByTestId("pricing-use-case-other-input")).toBeNull();
	fireEvent.click(screen.getByTestId("pricing-option-use_case-something_else"));
	expect(
		await screen.findByTestId("pricing-use-case-other-voice-record"),
	).toBeTruthy();

	// The timing box.
	next();
	await waitFor(() => expect(search()).toBe("?pc_step=3"));
	expect(screen.getByTestId("pricing-timing-voice-record")).toBeTruthy();

	// The box that shares the last step with the tickboxes.
	next();
	next();
	next();
	await waitFor(() => expect(search()).toBe("?pc_step=6"));
	expect(screen.getByTestId("pricing-context-voice-record")).toBeTruthy();
});

it("nudges towards the microphone only where the record button really is", async () => {
	// Voice is billed to a project, so a mount without one has no record button.
	// Telling somebody to press a button that is not there is worse than saying
	// nothing.
	const withVoice = renderConfigurator({
		entries: ["/workspace?pc_step=3"],
		projectId: "p-1",
	});
	await screen.findByTestId("pricing-timing-input");
	expect(screen.getByTestId("pricing-timing-voice-nudge").textContent).toBe(
		"Prefer talking? Press record and just say it.",
	);
	withVoice.view.unmount();
	cleanup();

	renderConfigurator({ entries: ["/workspace?pc_step=3"] });
	await screen.findByTestId("pricing-timing-input");
	expect(screen.queryByTestId("pricing-timing-voice-record")).toBeNull();
	expect(screen.queryByTestId("pricing-timing-voice-nudge")).toBeNull();
});

it("hides the record button where no project can be billed for the transcription", async () => {
	renderConfigurator({ entries: ["/workspace?pc_step=6"] });

	await screen.findByTestId("pricing-context-input");
	expect(screen.queryByTestId("pricing-context-voice-record")).toBeNull();
});

it("fills the timing box from an example, and the example rides on the answer", async () => {
	renderConfigurator({ entries: ["/workspace?pc_step=3"] });

	const box = (await screen.findByTestId(
		"pricing-timing-input",
	)) as HTMLTextAreaElement;
	fireEvent.click(screen.getByTestId("pricing-timing-example-six_weekends"));

	await waitFor(() =>
		expect(box.value).toBe("Six weekends across seven months"),
	);
	expect(readStoredConfiguration()?.answers.timing_example).toBe(
		"six_weekends",
	);
});

it("fills the shared free text box from one of the four examples", async () => {
	renderConfigurator({ entries: ["/workspace?pc_step=6"] });

	const box = (await screen.findByTestId(
		"pricing-context-input",
	)) as HTMLTextAreaElement;
	expect(screen.getByTestId("pricing-option-extras-event_help")).toBeTruthy();
	fireEvent.click(screen.getByTestId("pricing-context-example-urgent"));

	await waitFor(() => expect(box.value).toBe("This is urgent"));
	expect(readStoredConfiguration()?.answers.context).toBe("This is urgent");
});

// 8. The answers are saved before the booking opens, and the booking carries them.

it("never opens the booking step without a reference", async () => {
	renderConfigurator({ entries: ["/workspace?pc_step=book"] });

	await waitFor(() => expect(search()).toBe("?pc_step=book"));
	expect(screen.queryByTestId("pricing-configurator-booking")).toBeNull();
	expect(
		screen.queryByTestId("pricing-configurator-booking-fallback"),
	).toBeNull();
});

it("holds the booking step until the save comes back with the reference", async () => {
	let land: (result: { reference: string }) => void = () => {};
	const submit = submitMock().mockImplementation(
		() =>
			new Promise<{ reference: string }>((resolve) => {
				land = resolve;
			}),
	);
	renderConfigurator({ entries: ["/workspace?pc_step=6"], submit });

	await screen.findByTestId("pricing-context-input");
	next();

	await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
	// The write is in flight, so there is no reference and no calendar yet.
	expect(search()).toBe("?pc_step=6");
	expect(screen.queryByTestId("pricing-configurator-booking")).toBeNull();

	land({ reference: "DEM-4F2A" });

	await waitFor(() => expect(search()).toBe("?pc_step=book"));
	expect(
		await screen.findByTestId("pricing-configurator-booking"),
	).toBeTruthy();
	// The doubled "Pick a time. Please pick a time..." is gone: the title says
	// who, and the step says what they will do with the answers.
	expect(modalText()).toContain("Pick a time with Eve.");
	expect(modalText()).toContain(
		"Eve will read your answers before the call and brings a draft offer.",
	);
});

it("keeps the person on the last question when the save fails", async () => {
	const submit = submitMock().mockRejectedValue(new Error("network down"));
	renderConfigurator({ entries: ["/workspace?pc_step=6"], submit });

	await screen.findByTestId("pricing-context-input");
	next();

	await waitFor(() =>
		expect(screen.getByTestId("pricing-configurator-send-failed")).toBeTruthy(),
	);
	expect(search()).toBe("?pc_step=6");
	expect(screen.queryByTestId("pricing-configurator-booking")).toBeNull();
});

it("hands the booking the answers the person gave, under the same reference", async () => {
	// The `Cal` global as the page sees it once the script has landed. The real
	// embed is never loaded.
	const inline = vi.fn();
	(globalThis as { Cal?: unknown }).Cal = Object.assign(vi.fn(), {
		ns: { [BookingLinks.EMBED_NAMESPACE]: inline },
	});
	const script = document.createElement("script");
	script.src = BookingLinks.EMBED_SCRIPT;
	document.head.appendChild(script);

	seed({ volume: "50_to_250" });
	const submit = submitMock().mockResolvedValue({ reference: "DEM-4F2A" });
	renderConfigurator({ entries: ["/workspace?pc_step=6"], submit });

	await screen.findByTestId("pricing-context-input");
	next();

	await waitFor(() => expect(search()).toBe("?pc_step=book"));
	await waitFor(() => expect(inline).toHaveBeenCalled());

	const { config } = inline.mock.calls[0][1] as {
		config: Record<string, string>;
	};
	expect(config.notes).toContain("Reference DEM-4F2A");
	expect(config.notes).toContain(
		"How many recordings do you expect in your first year? 50 to 250",
	);
	expect(config["metadata[reference]"]).toBe("DEM-4F2A");
});

it("opens a number box above 40 and shows the one inline error on the attempt", async () => {
	renderConfigurator({ entries: ["/workspace?pc_step=5"] });

	await waitFor(() => expect(search()).toBe("?pc_step=5"));
	expect(screen.queryByTestId("pricing-concurrency-exact")).toBeNull();

	fireEvent.click(
		screen.getByTestId("pricing-option-concurrency-more_than_40"),
	);
	const box = await screen.findByTestId("pricing-concurrency-exact");
	// The helper line, quiet under the box before anything goes wrong.
	expect(
		screen.getByText('A rough number or "not sure". Either is useful.'),
	).toBeTruthy();

	// Nothing is required, so an empty box is not an error.
	next();
	await waitFor(() => expect(search()).toBe("?pc_step=6"));
	fireEvent.click(screen.getByTestId("pricing-configurator-back"));
	await waitFor(() => expect(search()).toBe("?pc_step=5"));

	fireEvent.change(screen.getByTestId("pricing-concurrency-exact"), {
		target: { value: "forty-ish" },
	});
	next();

	expect(search()).toBe("?pc_step=5");
	// The same sentence, now in red, and only once.
	expect(
		screen.getAllByText('A rough number or "not sure". Either is useful.'),
	).toHaveLength(1);

	fireEvent.change(screen.getByTestId("pricing-concurrency-exact"), {
		target: { value: "120" },
	});
	next();
	await waitFor(() => expect(search()).toBe("?pc_step=6"));
	expect(box).toBeTruthy();
});

// 9. The confirmation, and the mail that can find the answers again.

const confirmBooking = () => {
	fireEvent(
		window,
		new MessageEvent("message", {
			data: {
				data: { startTime: "2026-09-01T09:00:00.000Z", status: "accepted" },
				originator: "CAL",
				type: "bookingSuccessfulV2",
			},
			origin: "https://app.cal.com",
		}),
	);
};

it("puts the reference in the subject of the confirmation mail link", async () => {
	const submit = submitMock().mockResolvedValue({ reference: "DEM-4F2A" });
	renderConfigurator({ entries: ["/workspace?pc_step=6"], submit });

	await screen.findByTestId("pricing-context-input");
	next();
	await waitFor(() => expect(search()).toBe("?pc_step=book"));

	confirmBooking();
	await waitFor(() => expect(search()).toBe("?pc_step=done"));

	const link = screen.getByTestId(
		"pricing-configurator-support-mail",
	) as HTMLAnchorElement;
	expect(link.textContent).toBe("info@dembrane.com");
	expect(link.getAttribute("href")).toBe(
		"mailto:info@dembrane.com?subject=Reference%20DEM-4F2A",
	);

	const text = modalText();
	expect(text).toContain("Your call is booked:");
	expect(text).toContain("The invite is in your inbox.");
	expect(text).toContain("Reference DEM-4F2A");
	expect(
		screen.getByTestId("pricing-configurator-back-to-dembrane"),
	).toBeTruthy();
});

// 10. The price anchor line, behind its feature flag.

it("shows the price line only for the anchor variant, and says which one rode along", async () => {
	// Unresolved flag: no number anywhere, which is the whole flow's default.
	const quiet = renderConfigurator();
	await waitFor(() => expect(search()).toBe("?pc_step=1"));
	expect(screen.queryByTestId("pricing-configurator-anchor")).toBeNull();
	expect(modalText()).not.toContain("€");
	expect(
		quiet.onEvent.mock.calls.find(
			([name]) => name === "pricing_config_started",
		)?.[1],
	).toMatchObject({ price_anchor: "none" });
	quiet.view.unmount();
	cleanup();

	// Another value is not the variant either.
	flag.value = "control";
	const control = renderConfigurator();
	await waitFor(() => expect(search()).toBe("?pc_step=1"));
	expect(screen.queryByTestId("pricing-configurator-anchor")).toBeNull();
	control.view.unmount();
	cleanup();

	flag.value = "anchor";
	flag.payload = { line: { "en-US": "A line from the flag payload." } };
	const anchored = renderConfigurator();
	await waitFor(() => expect(search()).toBe("?pc_step=1"));
	expect(screen.getByTestId("pricing-configurator-anchor").textContent).toBe(
		"A line from the flag payload.",
	);
	expect(
		anchored.onEvent.mock.calls.find(
			([name]) => name === "pricing_config_started",
		)?.[1],
	).toMatchObject({ price_anchor: "anchor" });
});
