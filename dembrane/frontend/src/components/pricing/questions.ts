import { t } from "@lingui/core/macro";

/** The question set, as data. One typed list with a version beside it.
 *
 * The questions are a starting point and new versions get pushed. A version
 * change must be an edit, not a rebuild. So adding an option, moving a
 * question or renaming a label touches this file and nothing else.
 *
 * The wording is agreed copy. Take it exactly as written. Do not reword it
 * here.
 *
 * The labels are built inside a function on purpose. A `t` macro at module
 * scope freezes the string at import, before a locale is active, so the list
 * would render in whatever language loaded first.
 */

/** Bump when a question, an option or an option key changes.
 *
 * It is written onto every event and every row, so an old row still says
 * which form it answered.
 */
export const QUESTION_SET_VERSION = "21-aug-26";

/** Bump only when the keys of the `config` object change. It moves on its own
 * clock, far more slowly than the question set.
 *
 * Renaming an option key or moving a question between steps does not touch
 * the keys of `config`, so neither moves this number.
 */
export const CONFIG_SHAPE_VERSION = 1;

export type QuestionKey =
	| "use_case"
	| "timing"
	| "volume"
	| "concurrency"
	| "extras"
	| "context";

/** Step 1 is the opening, not a question.
 *
 * The opening is numbered step 1 of 6, so the person meets the progress line
 * already one step in. That is endowed progress: an artificial head start
 * measurably raises follow through, and here it is not even artificial,
 * because the wall really did tell us what they were trying to do. The first
 * question is therefore step 2.
 */
export const OPENING_STEP = 1;

/** The order the person meets the questions, one per step.
 *
 * Step N is `QUESTION_KEYS[N - 2]`, because step 1 is the opening.
 *
 * Timing is the first question after the opening: it is easy and concrete, so
 * it builds momentum before anything that needs a guess.
 */
export const QUESTION_KEYS: readonly QuestionKey[] = [
	"use_case",
	"timing",
	"volume",
	"concurrency",
	"extras",
];

/** Every key that can carry an answer.
 *
 * One longer than `QUESTION_KEYS`: `context` is the free text that shares the
 * last step with `extras`, so it is an answer without being a step. The
 * `answered` count in `config` still counts six things.
 */
export const ANSWER_KEYS: readonly QuestionKey[] = [
	...QUESTION_KEYS,
	"context",
];

/** The opening plus one step per question. */
export const STEP_COUNT = QUESTION_KEYS.length + 1;

/** What a tick or a radio reveals under itself when it is chosen.
 *
 * This is also what `action=opened` means on an option: an option revealed a
 * nested control. A plain tickbox with nothing under it has nothing to open.
 */
export type OptionReveals = "text" | "number";

export type QuestionOption = {
	/** Stable key. It travels on every event and every row, never the label. */
	key: string;
	label: string;
	/** One plain line under the option. The last step carries these, and the
	 * line being visible is what makes "opened but not selected" a real
	 * signal. */
	description?: string;
	reveals?: OptionReveals;
};

/** A question answered in the person's own words. */
export type TextQuestion = {
	key: QuestionKey;
	kind: "text";
	label: string;
	hint?: string;
	/** Tapping one fills the box, and then it can be edited. The examples are
	 * the question. */
	examples?: QuestionOption[];
};

/** A question answered by ticking or picking. `multi` and `single` differ only
 * in how many may be chosen. */
export type OptionsQuestion = {
	key: QuestionKey;
	kind: "multi" | "single";
	label: string;
	hint?: string;
	options: QuestionOption[];
	/** A free text box that shares this step, under the options.
	 *
	 * "Anything else you'd like to share" sits on the same screen as the
	 * tickboxes, so the form ends on one page rather than two. It is a real
	 * answer with its own key and its own label, which is why it is a question
	 * and not a stray input: the booking summary reads its label the same way
	 * it reads every other one.
	 */
	follow?: TextQuestion;
};

export type Question = OptionsQuestion | TextQuestion;

/** The five questions, in order.
 *
 * Call this during a render so the labels follow the active locale.
 */
export const getQuestionSet = (): Question[] => [
	{
		hint: t`Tick anything that fits.`,
		key: "use_case",
		kind: "multi",
		label: t`What do you want to use dembrane for?`,
		options: [
			{ key: "event_workshop", label: t`An event or a workshop.` },
			{ key: "assembly", label: t`An assembly.` },
			{ key: "conference_sessions", label: t`Recording conference sessions.` },
			{
				key: "in_person",
				label: t`Recording conversations you have in person, like street interviews.`,
			},
			{
				key: "audio_survey",
				label: t`Collecting people's stories without you being there, like an audio-based survey.`,
			},
			{ key: "something_else", label: t`Something else.`, reveals: "text" },
		],
	},
	{
		examples: [
			{ key: "one_day_october", label: t`One day in October` },
			{ key: "six_weekends", label: t`Six weekends across seven months` },
			{ key: "every_week_year", label: t`Every week for a year` },
			{ key: "one_big_event", label: t`One big event at the end of the year` },
			{ key: "always_on", label: t`Always on, it lives on our website` },
			{ key: "know_in_a_week", label: t`I will know in a week or two` },
		],
		hint: t`However you would say it. A date, a season, or that you do not know yet.`,
		key: "timing",
		kind: "text",
		label: t`When do you need dembrane?`,
	},
	{
		key: "volume",
		kind: "single",
		label: t`How many recordings do you expect in your first year?`,
		options: [
			{ key: "under_50", label: t`Under 50.` },
			{ key: "50_to_250", label: t`50 to 250.` },
			{ key: "250_to_1000", label: t`250 to 1000.` },
			{ key: "over_1000", label: t`More than 1000.` },
			{ key: "not_sure", label: t`Not sure yet.` },
		],
	},
	{
		hint: t`When someone scans the QR code, that is one conversation. If 50 people scan it at the same time, that is 50 conversations at once.`,
		key: "concurrency",
		kind: "single",
		label: t`At your busiest moment, how many conversations will be running at once?`,
		options: [
			{ key: "just_one", label: t`Just one.` },
			{ key: "2_to_5", label: t`2 to 5.` },
			{ key: "6_to_15", label: t`6 to 15.` },
			{ key: "16_to_40", label: t`16 to 40.` },
			{ key: "more_than_40", label: t`More than 40.`, reveals: "number" },
			{ key: "not_sure", label: t`Not sure yet.` },
		],
	},
	{
		follow: {
			examples: [
				{ key: "urgent", label: t`This is urgent` },
				{ key: "many_events", label: t`I have lots of big events coming up` },
				{
					key: "language",
					label: t`I need a specific language to be supported`,
				},
				{ key: "privacy", label: t`I need strict privacy guarantees` },
			],
			key: "context",
			kind: "text",
			label: t`Anything else you'd like to share`,
		},
		hint: t`Tick anything that applies.`,
		key: "extras",
		kind: "multi",
		label: t`Anything else you might need?`,
		options: [
			{
				description: t`We set up the project, stand beside you on the day, and help write the report afterwards.`,
				key: "event_help",
				label: t`Event help from the dembrane team`,
			},
			{
				description: t`Things like: A call with your DPO or CISO, a security review or custom DPIA.`,
				key: "procurement_help",
				label: t`Procurement help`,
			},
		],
	},
];

/** The step a question sits on, 1 based, with the opening as step 1. */
export const stepForQuestion = (key: QuestionKey): number =>
	QUESTION_KEYS.indexOf(key) + 1 + OPENING_STEP;
