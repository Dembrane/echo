// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { BookingLinks } from "@/lib/links";
import {
	BOOKING_REFERENCE_METADATA_KEY,
	buildBookingPrefill,
	buildBookingSummary,
} from "./bookingPrefill";
import type { Answers } from "./configuratorState";
import { bookingHostName, PricingBookingStep } from "./PricingBookingStep";
import { getQuestionSet, type Question } from "./questions";

/** The booking step, and what the booking carries.
 *
 * The real embed is never loaded here. The `Cal` global is a mock, exactly as
 * the person on the page would see it once the script has landed, so the test
 * reads what we hand cal.com without ever reaching cal.com.
 */

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
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
	(globalThis as { Cal?: unknown }).Cal = undefined;
	for (const script of document.querySelectorAll(
		`script[src="${BookingLinks.EMBED_SCRIPT}"]`,
	)) {
		script.remove();
	}
});

/** The embed as the page sees it once the script has loaded: a `Cal` function
 * with a namespace on it. Never the real one. */
const mockCal = () => {
	const inline = vi.fn();
	const cal = Object.assign(vi.fn(), {
		ns: { [BookingLinks.EMBED_NAMESPACE]: inline },
	});
	(globalThis as { Cal?: unknown }).Cal = cal;
	// The component only mounts against a script that is already on the page.
	const script = document.createElement("script");
	script.src = BookingLinks.EMBED_SCRIPT;
	document.head.appendChild(script);
	return { cal, inline };
};

const ANSWERS: Answers = {
	concurrency: "more_than_40",
	concurrency_exact: "120",
	context: "A citizens assembly on housing, about sixty people in one room.",
	extras: ["event_help"],
	timing: "Six weekends across seven months",
	use_case: ["assembly", "something_else"],
	use_case_other: "a museum tour",
	volume: "50_to_250",
};

const renderStep = ({
	answers = ANSWERS,
	reference = "DEM-4F2A",
}: {
	answers?: Answers;
	reference?: string;
} = {}) => {
	const onBooked = vi.fn();
	const onOpened = vi.fn();
	const onUnavailable = vi.fn();
	const prefill = buildBookingPrefill({
		answers,
		questions: getQuestionSet(),
		reference,
	});
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<PricingBookingStep
					onBooked={onBooked}
					onOpened={onOpened}
					onUnavailable={onUnavailable}
					prefill={prefill}
					reference={reference}
				/>
			</MantineProvider>
		</I18nProvider>,
	);
	return { onBooked, onOpened, onUnavailable, prefill };
};

// 1. The summary: the buckets and the timing text, in the words the person read.

it("builds the summary from the question labels, never from option keys", () => {
	const summary = buildBookingSummary({
		answers: ANSWERS,
		questions: getQuestionSet(),
		reference: "DEM-4F2A",
	});

	expect(summary.split("\n")).toEqual([
		"Reference DEM-4F2A",
		"What do you want to use dembrane for? An assembly, Something else: a museum tour",
		"When do you need dembrane? Six weekends across seven months",
		"How many recordings do you expect in your first year? 50 to 250",
		"At your busiest moment, how many conversations will be running at once? More than 40 (120)",
		"Anything else you might need? Event help from the dembrane team",
		// The free text that shares the last step reads as its own line, and its
		// label carries a colon because it is not a question.
		"Anything else you'd like to share: A citizens assembly on housing, about sixty people in one room.",
	]);

	// Only the snake_case keys are checked. A label can of course hold the word
	// "assembly": what must never appear is the key an event travels on.
	for (const key of [
		"something_else",
		"50_to_250",
		"more_than_40",
		"event_help",
	]) {
		expect(summary).not.toContain(key);
	}
});

it("leaves a skipped question out, because nothing is required", () => {
	const summary = buildBookingSummary({
		answers: { volume: "under_50" },
		questions: getQuestionSet(),
		reference: "DEM-0000",
	});

	expect(summary).toBe(
		"Reference DEM-0000\nHow many recordings do you expect in your first year? Under 50",
	);
});

it("still names the reference when every question was skipped", () => {
	expect(
		buildBookingSummary({
			answers: {},
			questions: getQuestionSet(),
			reference: "DEM-0000",
		}),
	).toBe("Reference DEM-0000");
});

it("follows a relabelled question set rather than a copy of the words", () => {
	// A question set version is an edit to `questions.ts` and nothing else. The
	// summary has to move with it, which is why it reads labels and not keys.
	const questions: Question[] = getQuestionSet().map((question) =>
		question.key === "volume" && question.kind === "single"
			? {
					...question,
					label: "How many recordings, roughly?",
					options: question.options.map((option) =>
						option.key === "50_to_250"
							? { ...option, label: "Between 50 and 250" }
							: option,
					),
				}
			: question,
	);

	const summary = buildBookingSummary({
		answers: { volume: "50_to_250" },
		questions,
		reference: "DEM-4F2A",
	});

	expect(summary).toContain("How many recordings, roughly? Between 50 and 250");
	expect(summary).not.toContain("50 to 250.");
});

it("keeps one long answer to one readable line", () => {
	const summary = buildBookingSummary({
		answers: { context: `${"word ".repeat(200)}\n\nand a second thought` },
		questions: getQuestionSet(),
		reference: "DEM-4F2A",
	});

	const contextLine = summary.split("\n")[1];
	expect(summary.split("\n")).toHaveLength(2);
	expect(contextLine.length).toBeLessThanOrEqual(250);
	expect(contextLine.endsWith("...")).toBe(true);
});

// 2. The prefill map: the reference and the summary, in cal.com's own keys.

it("carries the reference as the join key and the summary as the note", () => {
	const prefill = buildBookingPrefill({
		answers: ANSWERS,
		questions: getQuestionSet(),
		reference: "DEM-4F2A",
	});

	expect(Object.keys(prefill).sort()).toEqual([
		BOOKING_REFERENCE_METADATA_KEY,
		"notes",
	]);
	expect(prefill[BOOKING_REFERENCE_METADATA_KEY]).toBe("DEM-4F2A");
	expect(prefill.notes.startsWith("Reference DEM-4F2A\n")).toBe(true);
});

it("prefills a name and a mail address only when the app already knows them", () => {
	const base = {
		answers: ANSWERS,
		questions: getQuestionSet(),
		reference: "DEM-4F2A",
	};

	// Nothing known: cal.com asks, as it does today.
	expect(buildBookingPrefill(base).name).toBeUndefined();
	expect(buildBookingPrefill({ ...base, attendee: {} }).email).toBeUndefined();
	expect(
		buildBookingPrefill({ ...base, attendee: { name: "  " } }).name,
	).toBeUndefined();

	const known = buildBookingPrefill({
		...base,
		attendee: { email: "pieter@example.org", name: "Pieter" },
	});
	expect(known.name).toBe("Pieter");
	expect(known.email).toBe("pieter@example.org");
});

// 3. The embed gets the answers in its config.

it("hands the reference and the summary to the embed, with the layout kept", () => {
	const { inline } = mockCal();
	const { prefill } = renderStep();

	expect(inline).toHaveBeenCalledTimes(1);
	const [action, options] = inline.mock.calls[0] as [
		string,
		{ calLink: string; config: Record<string, string> },
	];
	expect(action).toBe("inline");
	expect(options.calLink).toBe(BookingLinks.CAL_LINK);
	expect(options.config.notes).toBe(prefill.notes);
	expect(options.config[BOOKING_REFERENCE_METADATA_KEY]).toBe("DEM-4F2A");
	expect(options.config.layout).toBe("month_view");
});

// 4. The fallback: the same answers, on the link, with the words from the copy.

it("falls back to the thank you, keeps the reference, and keeps a way to book", () => {
	vi.useFakeTimers();
	const { onOpened, onUnavailable } = renderStep();

	// Nothing from cal.com, which is what the CSP produces today.
	act(() => {
		vi.advanceTimersByTime(8000);
	});

	const fallback = screen.getByTestId("pricing-configurator-booking-fallback");
	expect(fallback.textContent).toContain(
		"Thank you! We will get in touch as soon as possible. You can also write to us at info@dembrane.com.",
	);
	// The reference keeps a line of its own, so it stays quotable in a mail.
	expect(
		screen.getByTestId("pricing-configurator-booking-reference").textContent,
	).toBe("Reference DEM-4F2A");
	// The button stays. Without it the calendar that just failed is the only
	// way to book, which is to say there is none.
	expect(
		screen.getByTestId("pricing-configurator-booking-link").textContent,
	).toBe("Pick a time");
	expect(onOpened).toHaveBeenCalledWith("fallback_link");
	expect(onUnavailable).toHaveBeenCalledWith("timeout", expect.any(Number));
});

it("names the host on the embed step, so the call is with a person", () => {
	mockCal();
	renderStep();

	expect(bookingHostName()).toBe("Eve");
	expect(
		screen.getByTestId("pricing-configurator-booking").textContent,
	).toContain(
		"Eve will read your answers before the call and brings a draft offer.",
	);
	// The doubled "Please pick a time..." line is gone.
	expect(
		screen.getByTestId("pricing-configurator-booking").textContent,
	).not.toContain("Please pick a time");
});

it("puts the same answers on the plain link, which is the only channel it has", () => {
	vi.useFakeTimers();
	const { prefill } = renderStep();
	act(() => {
		vi.advanceTimersByTime(8000);
	});

	const link = screen.getByTestId(
		"pricing-configurator-booking-link",
	) as HTMLAnchorElement;
	const url = new URL(link.href);

	expect(`${url.origin}${url.pathname}`).toBe(BookingLinks.BOOK_A_CALL);
	expect(url.searchParams.get("notes")).toBe(prefill.notes);
	expect(url.searchParams.get(BOOKING_REFERENCE_METADATA_KEY)).toBe("DEM-4F2A");
	// The whole thing stays inside the URL length old browsers and proxies keep.
	expect(link.href.length).toBeLessThan(2000);
	expect(link.target).toBe("_blank");
});
