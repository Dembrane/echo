import { t } from "@lingui/core/macro";
import type { Answers } from "./configuratorState";
import { parseExactCount } from "./configuratorState";
import type { Question, QuestionKey } from "./questions";

/** What travels with the booking, so nobody repeats themselves on the call.
 *
 * The row is already written when this runs, so the reference exists and the
 * answers are safe. This only decides what cal.com is told.
 *
 * Two channels, and they do different jobs:
 *
 * - `notes` is the "Additional notes" booking question. It is shown on the
 *   booking, so it is the one a person reads. It carries the reference and the
 *   plain summary.
 * - `metadata[reference]` is documented as machine only: it lands in the webhook
 *   payload under `payload.metadata` and in the booking table's metadata column,
 *   and cal.com states it does NOT appear on the booking details page. So it is
 *   the join key, never the message.
 *
 * Sources:
 * - https://cal.com/help/embedding/prefill-booking-form-embed
 *   `name`, `email`, `location` and `metadata[myKey]` inside the `config` object
 *   of `Cal("inline", {...})`, and "other fields can be prefilled in the similar
 *   way".
 * - https://cal.com/help/bookings/prefill-fields
 *   the field list the sentence above points at, `notes` among them, as query
 *   params on the booking page.
 * - https://cal.com/help/embedding/embed-auto-forward-query-params
 *   "you can pass any query param using the prefill config", which is what ties
 *   the two lists together: the config IS the query param channel.
 *
 * The same map therefore drives both routes: the embed `config` and the query
 * string on the plain link. One builder, so the two can never drift.
 */

/** Cal.com's own key for arbitrary data that rides with a booking. */
export const BOOKING_REFERENCE_METADATA_KEY = "metadata[reference]";

/** One free text answer, at most. A booking note is read by a person, and the
 * fallback route carries the same words in a URL, which has a practical
 * ceiling. */
const FREE_TEXT_LIMIT = 200;

/** The whole summary, at most. Six lines of labels plus capped answers stays
 * well inside the ~2000 character URL that old browsers and some proxies
 * enforce. */
const SUMMARY_LIMIT = 1200;

export type BookingAttendee = {
	/** Only ever what the app already knows. Nothing here is asked for or
	 * fetched: an empty value simply means cal.com asks for it, which is what it
	 * does today. */
	name?: string;
	email?: string;
};

const hasText = (value: string | undefined): value is string =>
	typeof value === "string" && value.trim().length > 0;

const cut = (value: string, limit: number): string =>
	value.length <= limit ? value : `${value.slice(0, limit - 3).trimEnd()}...`;

/** An option label as it reads inside a summary line.
 *
 * Option labels are written as sentences and end in a full stop, which is
 * right on a screen of tickboxes and wrong in a comma separated list: "An
 * assembly., Something else.: a museum tour". The wording is unchanged; only
 * the sentence stop goes.
 */
const asListItem = (label: string): string => label.replace(/\.$/, "");

/** One line, whatever the person typed. Newlines are collapsed so the summary
 * stays one line per question and reads the same in a note and in a URL. */
const oneLine = (value: string): string =>
	cut(value.replace(/\s+/g, " ").trim(), FREE_TEXT_LIMIT);

const listFor = (answers: Answers, key: QuestionKey): string[] | undefined => {
	if (key === "use_case") return answers.use_case;
	if (key === "extras") return answers.extras;
	return undefined;
};

const choiceFor = (answers: Answers, key: QuestionKey): string | undefined => {
	if (key === "volume") return answers.volume;
	if (key === "concurrency") return answers.concurrency;
	return undefined;
};

const textFor = (answers: Answers, key: QuestionKey): string | undefined => {
	if (key === "timing") return answers.timing;
	if (key === "context") return answers.context;
	return undefined;
};

/** The answer to one question, in the words the person saw. Null when the
 * question was skipped, and skipping is normal: nothing is required.
 *
 * Every word comes from the question set, never from an option key. A renamed
 * option therefore changes this summary in the same edit, and a new question
 * appears here without touching this file.
 */
const answerFor = (question: Question, answers: Answers): string | null => {
	if (question.kind === "multi") {
		const chosen = listFor(answers, question.key) ?? [];
		if (chosen.length === 0) return null;
		const parts = question.options
			.filter((option) => chosen.includes(option.key))
			.map((option) => {
				// The one option that opens a box of its own. Its text is the
				// answer, so it belongs beside the label rather than nowhere.
				if (option.reveals === "text" && hasText(answers.use_case_other)) {
					return `${asListItem(option.label)}: ${oneLine(answers.use_case_other)}`;
				}
				return asListItem(option.label);
			});
		return parts.length > 0 ? parts.join(", ") : null;
	}

	if (question.kind === "single") {
		const picked = choiceFor(answers, question.key);
		if (!hasText(picked)) return null;
		const option = question.options.find((one) => one.key === picked);
		if (!option) return null;
		const exact = parseExactCount(answers.concurrency_exact);
		if (option.reveals === "number" && exact !== undefined) {
			return `${asListItem(option.label)} (${exact})`;
		}
		return asListItem(option.label);
	}

	const typed = textFor(answers, question.key);
	return hasText(typed) ? oneLine(typed) : null;
};

/** One line of the summary: the question as the person read it, then their
 * answer.
 *
 * A label that already ends in a question mark reads fine with a space after
 * it. One that does not, like "Anything else you'd like to share", runs into
 * its own answer, so it gets a colon.
 */
const summaryLine = (label: string, value: string): string =>
	`${label}${label.endsWith("?") ? "" : ":"} ${value}`;

/** The plain summary that rides on the booking.
 *
 * The reference first, then one line per answered question: the question as the
 * person read it, then their answer. A skipped question is absent rather than
 * marked, because a list of blanks tells the reader nothing.
 *
 * It is built from the live question set, so it follows the locale the person
 * filled the form in. Their words, not a translation of them.
 *
 * The free text that shares the last step is read the same way as every other
 * answer, through its own label, so it costs this builder nothing but the
 * four lines below.
 */
export const buildBookingSummary = ({
	answers,
	questions,
	reference,
}: {
	answers: Answers;
	questions: Question[];
	reference: string;
}): string => {
	const lines = [t`Reference ${reference}`];
	for (const question of questions) {
		const value = answerFor(question, answers);
		if (value) lines.push(summaryLine(question.label, value));
		const follow = question.kind !== "text" ? question.follow : undefined;
		if (!follow) continue;
		const followValue = answerFor(follow, answers);
		if (followValue) lines.push(summaryLine(follow.label, followValue));
	}
	return cut(lines.join("\n"), SUMMARY_LIMIT);
};

/** The prefill map, for the embed config and for the plain link alike. */
export const buildBookingPrefill = ({
	answers,
	attendee,
	questions,
	reference,
}: {
	answers: Answers;
	attendee?: BookingAttendee;
	questions: Question[];
	reference: string;
}): Record<string, string> => {
	const prefill: Record<string, string> = {
		notes: buildBookingSummary({ answers, questions, reference }),
	};
	prefill[BOOKING_REFERENCE_METADATA_KEY] = reference;
	if (hasText(attendee?.name)) prefill.name = attendee.name.trim();
	if (hasText(attendee?.email)) prefill.email = attendee.email.trim();
	return prefill;
};

/** The fallback link, carrying the same answers as the embed.
 *
 * The plain link opens cal.com in a new tab and there is no channel back, so
 * the query string is the only thing we can hand over. It is the same map the
 * embed gets.
 */
export const bookingLinkWithPrefill = (
	baseUrl: string,
	prefill: Record<string, string>,
): string => {
	try {
		const url = new URL(baseUrl);
		for (const [key, value] of Object.entries(prefill)) {
			url.searchParams.set(key, value);
		}
		return url.toString();
	} catch {
		// A link that cannot be parsed still has to work. Better the bare booking
		// page than no way through at all.
		return baseUrl;
	}
};
