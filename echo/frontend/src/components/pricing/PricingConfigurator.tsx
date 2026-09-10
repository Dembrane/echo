import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Anchor,
	Box,
	Button,
	Checkbox,
	Divider,
	Group,
	Modal,
	Progress,
	Radio,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { wallActionLine } from "@/components/workspace/gateWalls";
import {
	BookingHost,
	BookingLinks,
	EventBookingHost,
	EventBookingLinks,
} from "@/lib/links";
import { testId } from "@/lib/testUtils";
import { buildBookingPrefill } from "./bookingPrefill";
import {
	type Answers,
	answeredCount,
	buildConfig,
	clearStoredConfiguration,
	hasUnreadableExactCount,
	newConfigSessionId,
	readStoredConfiguration,
	writeStoredConfiguration,
} from "./configuratorState";
import {
	type BookingSignal,
	bookingHostName,
	PricingBookingStep,
} from "./PricingBookingStep";
import { PricingTextInput } from "./PricingTextInput";
import { usePriceAnchorVariant } from "./priceAnchor";
import {
	CONFIG_SHAPE_VERSION,
	getQuestionSet,
	OPENING_STEP,
	QUESTION_KEYS,
	QUESTION_SET_VERSION,
	type Question,
	type QuestionKey,
	STEP_COUNT,
	type TextQuestion,
} from "./questions";
import {
	submitConfiguration as defaultSubmit,
	type SubmitConfiguration,
	submitFailureOf,
	type VoiceAttachment,
} from "./submitConfiguration";

/** The pricing configurator: one modal, six steps, then a booked call.
 *
 * Step 1 is the opening and steps 2 to 6 are the questions. The person meets
 * "Step 1 of 6" having already answered it by hitting the wall, so the
 * progress bar starts moving before they type anything.
 *
 * Every mount point opens this same modal. Nothing in it names the feature or
 * a tier. The one line that varies by wall is the opening, which names what
 * the person was TRYING to do, and the app already knows that because the wall
 * is keyed. The transcription cap adds one block above it, and that block is
 * the only other thing that ever differs.
 *
 * The step is a value in the URL query string, through react-router's own
 * `useSearchParams`. No new dependency, and the browser back button undoes a
 * step instead of leaving the page. The answers live in session storage under
 * the same `config_session_id`, so a reload comes back to the same attempt.
 *
 * Nothing is required. The form sends with every field empty and the row
 * records that.
 */

/** The URL key that carries the step. Prefixed so it cannot collide with the
 * filters and tabs that already live in the query string on these routes. */
export const STEP_PARAM = "pc_step";

/** The two values after the last question. Both are steps in the URL, so back
 * out of the calendar returns to question 6 rather than leaving the page. */
const BOOKING_STEP = "book";
const DONE_STEP = "done";
/** The portal only: the screen after the lead is captured, where the five
 * questions are offered as a favour rather than put in the way. */
const THANKS_STEP = "thanks";

/** Loose on purpose: cal.com validates the address properly on the booking.
 * This only stops an empty or obviously broken one from being sent. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type PricingConfiguratorEventHandler = (
	name: string,
	props: Record<string, unknown>,
) => void;

export type PricingConfiguratorProps = {
	/** The gate owns opening and closing. See `usePricingConfigurator`. */
	opened: boolean;
	onClose: () => void;
	/** Which wall started this session. It rides on every event. */
	wallKey?: string;
	/** `transcription_cap` puts the cap line above the free plan block. It is
	 * the only variant, and every other mount point is byte for byte the same. */
	variant?: "default" | "transcription_cap";
	/** What the app already knows about the person, and nothing more.
	 *
	 * Nothing sets these today, on purpose. The configurator asks no name and no
	 * mail address of its own, and this state fetches nothing new for them:
	 * cal.com asks for both on the booking form anyway. They exist so a mount
	 * point that already holds a signed in user can save that typing in one line,
	 * without this component learning about auth. On the website mount there is
	 * no signed in user at all, so they stay empty there.
	 */
	attendeeName?: string;
	attendeeEmail?: string;
	entry?: "popover_link" | "modal_direct";
	locale?: string;
	workspaceId?: string;
	orgId?: string;
	/** Transcription is billed to a project. Without one the voice button does
	 * not render, because the endpoint answers 403. */
	projectId?: string;
	/** `portal` is the participant portal's closing card: the opening asks for
	 * an email, the calendar is the event intake call, and voice is off. */
	mount?: "app" | "site" | "portal";
	/** Where the events go. A no-op by default: emitting is another state's job,
	 * and this only says when and with what. */
	onEvent?: PricingConfiguratorEventHandler;
	/** Injectable so the component can be driven against a mock. */
	submit?: SubmitConfiguration;
};

const noop: PricingConfiguratorEventHandler = () => {};

/** 1 to 6, or one of the two steps after the last question. */
type Phase =
	| { kind: "question"; step: number }
	| { kind: "thanks" }
	| { kind: "book" }
	| { kind: "done" };

const phaseFor = (raw: string | null): Phase => {
	if (raw === BOOKING_STEP) return { kind: "book" };
	if (raw === DONE_STEP) return { kind: "done" };
	if (raw === THANKS_STEP) return { kind: "thanks" };
	const parsed = Number.parseInt(raw ?? "", 10);
	if (Number.isNaN(parsed)) return { kind: "question", step: 1 };
	return { kind: "question", step: Math.min(Math.max(parsed, 1), STEP_COUNT) };
};

/** The question on this step, or undefined on the opening. */
const questionKeyForStep = (step: number): QuestionKey | undefined =>
	QUESTION_KEYS[step - 1 - OPENING_STEP];

/** The mail link on the confirmation, carrying the reference in its subject.
 *
 * The reference is the only thing that joins a mail back to the answers, so it
 * travels in the subject line rather than waiting to be typed. The parameter is
 * named `reference` so the subject reuses the message the reference line
 * already has, rather than minting a near duplicate for the catalogues.
 */
const supportMailto = (reference: string): string =>
	`mailto:info@dembrane.com?subject=${encodeURIComponent(t`Reference ${reference}`)}`;

export const PricingConfigurator = ({
	attendeeEmail,
	attendeeName,
	entry = "modal_direct",
	locale = "en-US",
	mount = "app",
	onClose,
	onEvent = noop,
	opened,
	orgId,
	projectId,
	submit = defaultSubmit,
	variant = "default",
	wallKey,
	workspaceId,
}: PricingConfiguratorProps) => {
	const [searchParams, setSearchParams] = useSearchParams();
	const rawStep = searchParams.get(STEP_PARAM);
	const phase = phaseFor(rawStep);
	// Behind a feature flag; shows one extra line on the opening step when the
	// variant is active. The variant rides on every event, so the booking rate
	// can be split by it.
	const { variant: priceAnchor, line: priceAnchorLine } =
		usePriceAnchorVariant(locale);

	const [sessionId, setSessionId] = useState<string | null>(null);
	const [answers, setAnswers] = useState<Answers>({});
	const [furthestStep, setFurthestStep] = useState(1);
	const [reference, setReference] = useState<string | null>(null);
	const [submitAttempt, setSubmitAttempt] = useState(0);
	const [isSending, setIsSending] = useState(false);
	const [sendFailed, setSendFailed] = useState(false);
	const [showExactError, setShowExactError] = useState(false);
	const [booking, setBooking] = useState<BookingSignal | null>(null);
	const [audio, setAudio] = useState<VoiceAttachment[]>([]);
	/** The booking step fell back to the plain link, so it now carries its own
	 * heading and the modal drops the step title. */
	const [bookingUnavailable, setBookingUnavailable] = useState(false);
	// The participant portal asks for an email on the opening: it has no
	// account to read one from and no booking yet to learn it from.
	const asksEmail = mount === "portal";
	// A phone gets the whole screen: the portal is used standing up, in a room.
	const isNarrow = useMediaQuery("(max-width: 48em)");
	const fullScreen = asksEmail && !!isNarrow;
	// Thumb-sized controls on the portal: `lg` clears the 44px guideline where
	// the theme's `md` lands at 38px.
	const controlSize = asksEmail ? "lg" : "md";
	const [email, setEmail] = useState("");
	const [showEmailError, setShowEmailError] = useState(false);
	const emailRef = useRef(email);
	emailRef.current = email;

	const headingRef = useRef<HTMLHeadingElement>(null);
	const initialisedRef = useRef(false);
	const startedRef = useRef(false);
	const seenStepsRef = useRef<Set<number>>(new Set());
	const openedAtRef = useRef(Date.now());
	const closedRef = useRef(false);
	const openedOptionsRef = useRef<Set<string>>(new Set());

	const questions = useMemo(() => getQuestionSet(), []);
	const config = useMemo(
		() => buildConfig(answers, furthestStep),
		[answers, furthestStep],
	);

	/** What the booking carries. It is only ever read once the reference exists,
	 * because the booking step does not render without one. */
	const prefill = useMemo(
		() =>
			buildBookingPrefill({
				answers,
				attendee: {
					email:
						attendeeEmail ??
						(asksEmail ? email.trim().toLowerCase() || undefined : undefined),
					name: attendeeName,
				},
				questions,
				reference: reference ?? "",
			}),
		[
			answers,
			asksEmail,
			attendeeEmail,
			attendeeName,
			email,
			questions,
			reference,
		],
	);

	// Read through a ref so the event helpers never go stale inside a listener
	// that was registered once.
	const configRef = useRef(config);
	configRef.current = config;
	const answersRef = useRef(answers);
	answersRef.current = answers;
	const furthestRef = useRef(furthestStep);
	furthestRef.current = furthestStep;
	const referenceRef = useRef(reference);
	referenceRef.current = reference;
	const sessionRef = useRef(sessionId);
	sessionRef.current = sessionId;

	/** Every event carries the join id and the question set version. The account
	 * side (workspace, org, tier, is_internal) is merged by the emitter. */
	const emit = useCallback(
		(name: string, props: Record<string, unknown> = {}) => {
			onEvent(name, {
				config_session_id: sessionRef.current,
				mount,
				price_anchor: priceAnchor,
				question_set_version: QUESTION_SET_VERSION,
				wall_key: wallKey,
				...props,
			});
		},
		[mount, onEvent, priceAnchor, wallKey],
	);

	const goTo = useCallback(
		(value: string) => {
			setSearchParams(
				(previous) => {
					const next = new URLSearchParams(previous);
					next.set(STEP_PARAM, value);
					return next;
				},
				{ replace: false },
			);
		},
		[setSearchParams],
	);

	const dropStepParam = useCallback(() => {
		setSearchParams(
			(previous) => {
				const next = new URLSearchParams(previous);
				next.delete(STEP_PARAM);
				return next;
			},
			{ replace: true },
		);
	}, [setSearchParams]);

	// Session id and answers, restored or minted. A reload finds the same
	// attempt rather than starting a second one.
	useEffect(() => {
		if (!opened) return;
		if (sessionRef.current) return;
		const stored = readStoredConfiguration();
		if (stored) {
			setSessionId(stored.config_session_id);
			setAnswers(stored.answers);
			setFurthestStep(stored.furthest_step);
			if (stored.email) setEmail(stored.email);
			sessionRef.current = stored.config_session_id;
			return;
		}
		const minted = newConfigSessionId();
		setSessionId(minted);
		sessionRef.current = minted;
		writeStoredConfiguration({
			answers: {},
			config_session_id: minted,
			furthest_step: 1,
			question_set_version: QUESTION_SET_VERSION,
		});
	}, [opened]);

	// The step lives in the URL. Opening pushes step 1, so back out of step 1
	// closes the modal instead of leaving the page.
	useEffect(() => {
		if (!opened) {
			initialisedRef.current = false;
			return;
		}
		if (rawStep === null) {
			if (initialisedRef.current) {
				onClose();
				return;
			}
			initialisedRef.current = true;
			goTo("1");
			return;
		}
		initialisedRef.current = true;
	}, [goTo, onClose, opened, rawStep]);

	// Reset the per-attempt bookkeeping when the modal opens.
	useEffect(() => {
		if (!opened) return;
		openedAtRef.current = Date.now();
		closedRef.current = false;
		seenStepsRef.current = new Set();
		startedRef.current = false;
		openedOptionsRef.current = new Set();
	}, [opened]);

	const persist = useCallback((next: Answers, step: number) => {
		const id = sessionRef.current;
		if (!id) return;
		writeStoredConfiguration({
			answers: next,
			config_session_id: id,
			email: emailRef.current.trim() || undefined,
			furthest_step: step,
			question_set_version: QUESTION_SET_VERSION,
		});
	}, []);

	const updateAnswers = useCallback(
		(patch: Partial<Answers>) => {
			setAnswers((previous) => {
				const next = { ...previous, ...patch };
				persist(next, furthestRef.current);
				return next;
			});
		},
		[persist],
	);

	const payloadFor = useCallback(
		(status: "in_progress" | "submitted") => ({
			answers_raw: answersRef.current,
			config: configRef.current,
			config_session_id: sessionRef.current ?? "",
			config_shape_version: CONFIG_SHAPE_VERSION,
			email: asksEmail
				? emailRef.current.trim().toLowerCase() || undefined
				: undefined,
			locale,
			mount,
			org_id: orgId,
			project_id: projectId,
			question_set_version: QUESTION_SET_VERSION,
			status,
			voice_audio: audio.length > 0 ? audio : undefined,
			wall_key: wallKey,
			workspace_id: workspaceId,
		}),
		[asksEmail, audio, locale, mount, orgId, projectId, wallKey, workspaceId],
	);

	/** A row exists from the first answer, so an abandoned attempt is still
	 * recorded. It is an upsert on the session id, and a failure here is silent
	 * because the person is mid form and there is nothing for them to do. */
	const persistProgress = useCallback(() => {
		if (!sessionRef.current) return;
		if (answeredCount(answersRef.current) === 0) return;
		void submit(payloadFor("in_progress")).catch(() => {});
	}, [payloadFor, submit]);

	// Both effects below key on the raw step string. `phase` is a new object on
	// every render, so depending on it would fire an event per render.

	// `started` fires when the modal renders with question 1 on screen.
	useEffect(() => {
		if (!opened || !sessionId) return;
		const current = phaseFor(rawStep);
		if (current.kind !== "question" || current.step !== 1) return;
		if (startedRef.current) return;
		startedRef.current = true;
		emit("pricing_config_started", {
			config: configRef.current,
			entry,
			resumed: answeredCount(answersRef.current) > 0,
		});
	}, [emit, entry, opened, rawStep, sessionId]);

	// `step_viewed` on every render of a question, and again on a revisit.
	// Every funnel filters on `first_view`, or a person who paged back counts
	// twice.
	useEffect(() => {
		if (!opened || !sessionId) return;
		const current = phaseFor(rawStep);
		if (current.kind !== "question") return;
		const step = current.step;
		const firstView = !seenStepsRef.current.has(step);
		seenStepsRef.current.add(step);
		setFurthestStep((previous) => Math.max(previous, step));
		// The opening carries no question, so it carries no `step_key`. Nothing
		// new is emitted for it: the property is simply absent, exactly as it is
		// for a question that does not exist.
		const stepKey = questionKeyForStep(step);
		emit("pricing_config_step_viewed", {
			config: configRef.current,
			first_view: firstView,
			step,
			...(stepKey ? { step_key: stepKey } : {}),
		});
	}, [emit, opened, rawStep, sessionId]);

	// Focus lands on the question heading at every step, so a keyboard reader
	// hears the question rather than the first control. It keys on the raw step
	// string, not on `phase`, which is a new object on every render and would
	// take focus back mid typing.
	// biome-ignore lint/correctness/useExhaustiveDependencies: rawStep is what moves the focus; the effect reads only the ref.
	useEffect(() => {
		if (!opened) return;
		headingRef.current?.focus();
	}, [opened, rawStep]);

	const closeWith = useCallback(
		(reason: "dismissed" | "pagehide" | "submitted" | "booked") => {
			if (closedRef.current) return;
			closedRef.current = true;
			emit("pricing_config_closed", {
				answered_count: answeredCount(answersRef.current),
				config: configRef.current,
				furthest_step: furthestRef.current,
				reason,
				seconds_open: Math.round((Date.now() - openedAtRef.current) / 1000),
				started: startedRef.current,
			});
		},
		[emit],
	);

	// Best effort, and not the truth. Abandonment rests on the server row.
	useEffect(() => {
		if (!opened) return;
		const onPageHide = () => closeWith("pagehide");
		globalThis.addEventListener("pagehide", onPageHide);
		return () => globalThis.removeEventListener("pagehide", onPageHide);
	}, [closeWith, opened]);

	const handleClose = useCallback(() => {
		closeWith(
			booking ? "booked" : referenceRef.current ? "submitted" : "dismissed",
		);
		// The draft is kept on a dismiss, so escape never costs an answer. It is
		// cleared once the attempt is finished and has its reference, and the
		// session id goes with it: reopening then starts a second attempt rather
		// than writing over the row that already produced a reference.
		if (referenceRef.current) {
			clearStoredConfiguration();
			sessionRef.current = null;
			setSessionId(null);
			setAnswers({});
			setFurthestStep(1);
			setReference(null);
			referenceRef.current = null;
			setBooking(null);
			setSubmitAttempt(0);
			setAudio([]);
			setEmail("");
		}
		dropStepParam();
		onClose();
	}, [booking, closeWith, dropStepParam, onClose]);

	const optionChanged = useCallback(
		(
			action: "opened" | "selected" | "deselected" | "invalid",
			questionKey: QuestionKey,
			optionKey: string,
			extra: Record<string, unknown> = {},
		) => {
			emit("pricing_config_option_changed", {
				action,
				config: configRef.current,
				option_key: optionKey,
				question_key: questionKey,
				...extra,
			});
		},
		[emit],
	);

	/** `opened` means an option revealed a nested control. It fires once per
	 * option per attempt, on a click and on keyboard focus alike. */
	const optionOpened = useCallback(
		(questionKey: QuestionKey, optionKey: string) => {
			const id = `${questionKey}:${optionKey}`;
			if (openedOptionsRef.current.has(id)) return;
			openedOptionsRef.current.add(id);
			optionChanged("opened", questionKey, optionKey);
		},
		[optionChanged],
	);

	/** One event per free text box, on leaving the step. The length, never the
	 * text: no free text ever leaves in an event.
	 *
	 * Keyed on the question rather than on the step number, so moving a question
	 * between steps cannot silently stop an event.
	 */
	const emitTextLength = useCallback(
		(key: QuestionKey) => {
			const current = answersRef.current;
			if (key === "use_case" && current.use_case_other?.trim()) {
				optionChanged("selected", "use_case", "something_else", {
					text_chars: current.use_case_other.length,
				});
			}
			if (key === "timing" && current.timing?.trim()) {
				optionChanged("selected", "timing", "free_text", {
					text_chars: current.timing.length,
				});
			}
			// The free text that shares the last step with the tickboxes.
			if (key === "extras" && current.context?.trim()) {
				optionChanged("selected", "context", "free_text", {
					text_chars: current.context.length,
				});
			}
		},
		[optionChanged],
	);

	const send = useCallback(async () => {
		const attempt = submitAttempt + 1;
		setSubmitAttempt(attempt);
		setIsSending(true);
		setSendFailed(false);
		try {
			const result = await submit(payloadFor("submitted"));
			setReference(result.reference);
			referenceRef.current = result.reference;
			emit("pricing_config_submitted", {
				answered_count: answeredCount(answersRef.current),
				concurrency_bucket: configRef.current.concurrency,
				config: configRef.current,
				reference: result.reference,
				seconds_in_form: Math.round((Date.now() - openedAtRef.current) / 1000),
				volume_bucket: configRef.current.volume,
			});
			goTo(BOOKING_STEP);
		} catch (error) {
			const failure = submitFailureOf(error);
			setSendFailed(true);
			emit("pricing_config_submit_failed", {
				attempt,
				config: configRef.current,
				reason: failure.reason,
				status: failure.status,
			});
		} finally {
			setIsSending(false);
		}
	}, [emit, goTo, payloadFor, submit, submitAttempt]);

	/** The portal's opening: the email alone captures the lead. The row is
	 * written as submitted right here, before any question, so a person who
	 * leaves at this point has still asked to be contacted. The questions that
	 * follow update the same row. */
	const sendLead = useCallback(async () => {
		setIsSending(true);
		setSendFailed(false);
		try {
			const result = await submit(payloadFor("submitted"));
			setReference(result.reference);
			referenceRef.current = result.reference;
			emit("pricing_config_lead_captured", {
				reference: result.reference,
				seconds_in_form: Math.round((Date.now() - openedAtRef.current) / 1000),
			});
			goTo(THANKS_STEP);
		} catch (error) {
			const failure = submitFailureOf(error);
			setSendFailed(true);
			emit("pricing_config_submit_failed", {
				attempt: 1,
				config: configRef.current,
				reason: failure.reason,
				status: failure.status,
			});
		} finally {
			setIsSending(false);
		}
	}, [emit, goTo, payloadFor, submit]);

	const advance = useCallback(() => {
		if (phase.kind !== "question") return;
		const step = phase.step;
		const key = questionKeyForStep(step);
		// The portal's opening carries the email, and it is the one thing the
		// form insists on: without it the lead cannot be answered at all.
		if (step === OPENING_STEP && asksEmail) {
			if (!EMAIL_PATTERN.test(emailRef.current.trim())) {
				setShowEmailError(true);
				return;
			}
			setShowEmailError(false);
			persist(answersRef.current, furthestRef.current);
			void sendLead();
			return;
		}
		// The one inline validation in the form, and it fires on the attempt.
		if (key === "concurrency" && hasUnreadableExactCount(answersRef.current)) {
			setShowExactError(true);
			optionChanged("invalid", "concurrency", "more_than_40");
			return;
		}
		setShowExactError(false);
		if (key) emitTextLength(key);
		if (step === STEP_COUNT) {
			void send();
			return;
		}
		persistProgress();
		goTo(String(step + 1));
	}, [
		asksEmail,
		emitTextLength,
		goTo,
		optionChanged,
		persist,
		persistProgress,
		phase,
		send,
		sendLead,
	]);

	/** The portal's exit from any question: whatever was answered goes onto
	 * the row, and the person is done. The lead already exists, so this write
	 * is best effort. */
	const finishEarly = useCallback(() => {
		if (phase.kind !== "question") return;
		const key = questionKeyForStep(phase.step);
		if (key) emitTextLength(key);
		void submit(payloadFor("submitted")).catch(() => {});
		emit("pricing_config_finished_early", {
			answered_count: answeredCount(answersRef.current),
			config: configRef.current,
			step: phase.step,
		});
		goTo(DONE_STEP);
	}, [emit, emitTextLength, goTo, payloadFor, phase, submit]);

	const back = useCallback(() => {
		if (phase.kind !== "question" || phase.step <= OPENING_STEP) return;
		goTo(String(phase.step - 1));
	}, [goTo, phase]);

	/** Tell the row what cal.com just confirmed.
	 *
	 * The same upsert the answers took, on the same session id, carrying the
	 * three booking fields. It is fire and forget with one retry: the booking
	 * exists in cal.com whether or not this lands, so making a person wait on
	 * our own write would trade something true for something that can be
	 * retried. After two failures it goes quiet, because the row still holds
	 * the answers and the reference still finds the booking.
	 *
	 * No uid means nothing to join on, so nothing is sent.
	 */
	const reportBooking = useCallback(
		(signal: BookingSignal) => {
			if (!sessionRef.current || !signal.uid) return;
			const report = {
				...payloadFor("submitted"),
				booking_start: signal.startTime ?? undefined,
				booking_status: signal.status ?? undefined,
				booking_uid: signal.uid,
				// The recordings already travelled with the answers. Sending them
				// again would upload the same audio a second time.
				voice_audio: undefined,
			};
			void submit(report).catch(() => submit(report).catch(() => {}));
		},
		[payloadFor, submit],
	);

	const handleBooked = useCallback(
		(signal: BookingSignal) => {
			setBooking(signal);
			reportBooking(signal);
			emit("pricing_config_booking_confirmed", {
				reference: referenceRef.current,
				seconds_after_open: signal.secondsAfterOpen,
				signal: signal.signal,
			});
			goTo(DONE_STEP);
		},
		[emit, goTo, reportBooking],
	);

	const handleBookingOpened = useCallback(
		(route: "embed" | "fallback_link") => {
			emit("pricing_config_booking_opened", {
				reference: referenceRef.current,
				route,
			});
		},
		[emit],
	);

	const handleBookingUnavailable = useCallback(
		(reason: "timeout" | "blocked", secondsWaited: number) => {
			setBookingUnavailable(true);
			emit("pricing_config_booking_unavailable", {
				reason,
				seconds_waited: secondsWaited,
			});
		},
		[emit],
	);

	// Leaving the booking step puts the step title back, so a person who pages
	// back to the last question and forward again meets the embed with its own
	// title rather than a headerless modal.
	useEffect(() => {
		if (rawStep !== BOOKING_STEP) setBookingUnavailable(false);
	}, [rawStep]);

	const retainAudio = useCallback(
		(questionKey: string) => (attachment: VoiceAttachment | null) => {
			setAudio((previous) => {
				const rest = previous.filter(
					(item) => item.question_key !== questionKey,
				);
				return attachment ? [...rest, attachment] : rest;
			});
		},
		[],
	);

	const headingId = "pricing-configurator-question";
	const isConfirmed = booking?.status === "accepted";
	const host = bookingHostName(asksEmail ? EventBookingHost : BookingHost);
	const bookedTime = booking?.startTime
		? formatBookingTime(booking.startTime)
		: null;
	// What the person was trying to do when they met the wall. Empty on the
	// billing page, which is not a wall, and on a mount that names none.
	const action = wallActionLine(wallKey);

	// The fallback screen carries its own thank you line rather than a heading,
	// so the step title is dropped while it is up: naming a host above a
	// calendar that did not load would be a second untrue thing on the screen.
	// The close button keeps the header, because Mantine renders it either way.
	const title =
		phase.kind === "book" ? (
			bookingUnavailable ? undefined : (
				<Trans>Pick a time with {host}.</Trans>
			)
		) : phase.kind === "done" ? (
			isConfirmed ? (
				bookedTime ? (
					<Trans>Your call is booked: {bookedTime}.</Trans>
				) : (
					<Trans>Your call is booked.</Trans>
				)
			) : (
				<Trans>Your request is in.</Trans>
			)
		) : phase.kind === "thanks" ? (
			<Trans>Thanks, we will be in touch within a day.</Trans>
		) : asksEmail &&
			phase.step ===
				OPENING_STEP ? // The heading below is the whole ask; a title above it would say it twice.
		undefined : (
			<Trans>Can you tell us more?</Trans>
		);

	return (
		// `centered` is the house pattern: the theme sets no default and every
		// other modal in the app passes it, so without it this one alone sat high
		// on the viewport.
		<Modal
			centered
			fullScreen={fullScreen}
			onClose={handleClose}
			opened={opened}
			padding={fullScreen ? "lg" : "md"}
			size={896}
			// On the phone sheet the body is a column and the controls take
			// `mt="auto"`, so they sit along the bottom, clear of the home bar.
			styles={
				fullScreen
					? {
							body: {
								display: "flex",
								flex: 1,
								flexDirection: "column",
								// A flex item will not shrink below its content unless it is
								// told it may, and without that the sheet grew past the
								// screen on a small phone and took the buttons with it.
								// `minHeight: 0` lets it shrink; the overflow then scrolls.
								minHeight: 0,
								overflowY: "auto",
								paddingBottom:
									"max(var(--mantine-spacing-lg), env(safe-area-inset-bottom))",
							},
							content: { display: "flex", flexDirection: "column" },
						}
					: undefined
			}
			title={title}
			{...testId("pricing-configurator-modal")}
		>
			{phase.kind === "question" && (
				<Stack gap="lg" style={fullScreen ? { flex: 1 } : undefined}>
					{/* The locked data exception, and the only block that ever sits
					    above the opening. Nothing was blocked while recording, so
					    the block says so before anything asks for money. */}
					{phase.step === OPENING_STEP && variant === "transcription_cap" && (
						<>
							<Stack gap="xs">
								<Text fw={500}>
									<Trans>Your free transcription hour is used up.</Trans>
								</Text>
								<Text size="sm">
									<Trans>
										The portals will keep working! Your participants are never
										cut off and nothing they say is lost. Once you are on a paid
										plan, transcription catches up on everything already
										recorded.
									</Trans>
								</Text>
							</Stack>
							<Divider />
						</>
					)}

					{asksEmail ? (
						// A thin bar says how far along the optional questions are; the
						// count is kept for the screen reader.
						phase.step > OPENING_STEP && (
							<Progress
								aria-label={t`Optional question ${phase.step - OPENING_STEP} of ${STEP_COUNT - OPENING_STEP}`}
								radius="xl"
								size="sm"
								value={
									((phase.step - OPENING_STEP) / (STEP_COUNT - OPENING_STEP)) *
									100
								}
								{...testId("pricing-configurator-progress")}
							/>
						)
					) : (
						<Text role="status" size="sm">
							<Trans>
								Step {phase.step} of {STEP_COUNT}
							</Trans>
						</Text>
					)}

					<form
						onSubmit={(event) => {
							event.preventDefault();
							advance();
						}}
						style={
							fullScreen
								? { display: "flex", flex: 1, flexDirection: "column" }
								: undefined
						}
					>
						<Stack gap="lg" style={fullScreen ? { flex: 1 } : undefined}>
							{/* On the phone the ask sits in the middle of the sheet rather
							    than at the top: the options are what a thumb has to reach,
							    and the top of a tall screen is the hardest place to reach.
							    Auto margins split the free space above and below; when the
							    question is taller than the sheet they collapse to nothing,
							    so a long list still starts at the top instead of clipping. */}
							<Stack gap="lg" my={fullScreen ? "auto" : undefined}>
								{phase.step === OPENING_STEP ? (
									// The opening is step 1 of 6, so the person is already one
									// step in when they arrive. The wall told us what they were
									// trying to do, which is the one line that varies here.
									<Stack gap="xs">
										{asksEmail ? (
											// The portal's opening. Nobody here met a wall and nobody
											// is on a plan, so it says what the form is for and asks
											// for the one thing it needs.
											<>
												<Title
													id={headingId}
													order={2}
													ref={headingRef}
													tabIndex={-1}
													{...testId("pricing-configurator-opening")}
												>
													<Trans>
														Leave your email so we can get in touch with you.
													</Trans>
												</Title>
												<TextInput
													autoComplete="email"
													error={
														showEmailError
															? t`That does not look like an email address.`
															: undefined
													}
													label={t`Your email`}
													mt="sm"
													onChange={(event) => {
														setEmail(event.currentTarget.value);
														if (showEmailError) setShowEmailError(false);
													}}
													placeholder={t`you@example.org`}
													size={controlSize}
													type="email"
													value={email}
													withAsterisk
													{...testId("pricing-configurator-email")}
												/>
											</>
										) : (
											<>
												<Title
													id={headingId}
													order={4}
													ref={headingRef}
													tabIndex={-1}
													{...testId("pricing-configurator-opening")}
												>
													{action ? (
														<Trans>You were trying to {action}.</Trans>
													) : (
														<Trans>You are on the free plan.</Trans>
													)}
												</Title>
												<Text size="sm">
													<Trans>
														That requires a paid plan. We're going to ask you 5
														more quick questions, then you pick a time with the
														dembrane team. We'll read your answers before the
														call to bring an offer that fits your needs.
													</Trans>
												</Text>
												{/* One optional line from the feature flag's payload, and
											    only for the share of people the flag holds. The words
											    live with the flag, not here. See `priceAnchor.ts`. */}
												{priceAnchor === "anchor" && priceAnchorLine && (
													<Text
														size="sm"
														{...testId("pricing-configurator-anchor")}
													>
														{priceAnchorLine}
													</Text>
												)}
											</>
										)}
									</Stack>
								) : (
									<QuestionBody
										answers={answers}
										headingId={headingId}
										headingRef={headingRef}
										onAudioRetained={retainAudio}
										onOptionChanged={optionChanged}
										onOptionOpened={optionOpened}
										onSubmit={advance}
										projectId={projectId}
										question={questions[phase.step - 1 - OPENING_STEP]}
										showExactError={showExactError}
										updateAnswers={updateAnswers}
										// A phone, held standing up: helper text one size up and
										// example buttons that are real tap targets.
										touch={asksEmail}
										// Voice needs a session for the transcription; a participant
										// has none, so the portal asks in writing only.
										voice={!asksEmail}
									/>
								)}

								{sendFailed && (
									<Text
										c="red"
										size="sm"
										{...testId("pricing-configurator-send-failed")}
									>
										<Trans>
											That didn't send. Your answers are still here, so try
											again.
										</Trans>
									</Text>
								)}
							</Stack>

							{/* `size={controlSize}` on every button in the modal, one step up from
							    Mantine's default, matching the onboarding questionnaire. */}
							{/* Not now stands for both the opening and the first question:
							    there is nothing behind the first question worth a Back.
							    Back, Skip and Next start together, one step later. */}
							<Stack gap="xs">
								{asksEmail && phase.step > OPENING_STEP && (
									<Group justify="flex-end">
										<Button
											onClick={finishEarly}
											size="sm"
											type="button"
											variant="subtle"
											{...testId("pricing-configurator-finish-early")}
										>
											<Trans>Done, reach out to me</Trans>
										</Button>
									</Group>
								)}
								<Group justify="flex-end">
									{(
										asksEmail
											? phase.step === OPENING_STEP
											: phase.step <= OPENING_STEP + 1
									) ? (
										<Button
											onClick={handleClose}
											size={controlSize}
											type="button"
											variant="subtle"
											{...testId("pricing-configurator-not-now")}
										>
											<Trans>Not now</Trans>
										</Button>
									) : (
										<Button
											onClick={back}
											size={controlSize}
											type="button"
											variant="subtle"
											{...testId("pricing-configurator-back")}
										>
											<Trans>Back</Trans>
										</Button>
									)}
									{(asksEmail
										? phase.step > OPENING_STEP
										: phase.step > OPENING_STEP + 1) &&
										phase.step < STEP_COUNT && (
											<Button
												onClick={advance}
												size={controlSize}
												type="button"
												variant="subtle"
												{...testId("pricing-configurator-skip")}
											>
												<Trans>Skip</Trans>
											</Button>
										)}
									<Button
										loading={isSending}
										size={controlSize}
										type="submit"
										{...testId("pricing-configurator-next")}
									>
										{phase.step === OPENING_STEP ? (
											asksEmail ? (
												<Trans>Reach out to me</Trans>
											) : (
												<Trans>Continue</Trans>
											)
										) : phase.step === OPENING_STEP + 1 && !asksEmail ? (
											<Trans>Let's go!</Trans>
										) : phase.step === STEP_COUNT ? (
											<Trans>Next: pick a time</Trans>
										) : (
											<Trans>Next</Trans>
										)}
									</Button>
								</Group>
							</Stack>
						</Stack>
					</form>
				</Stack>
			)}
			{/* The portal's thanks screen: the lead is in, the questions are a
			    favour, and saying so is the whole point of the screen. */}
			{phase.kind === "thanks" && (
				<Stack
					gap="lg"
					style={fullScreen ? { flex: 1 } : undefined}
					{...testId("pricing-configurator-thanks")}
				>
					<Text
						mt={fullScreen ? "auto" : undefined}
						style={{
							fontSize: "var(--app-heading-h2-size)",
							fontWeight: "var(--app-heading-font-weight, 300)",
							lineHeight: "var(--app-heading-h2-line-height)",
						}}
					>
						<Trans>
							Got two minutes? Five optional questions help us prepare.
						</Trans>
					</Text>
					<Group justify="flex-end" mt={fullScreen ? "auto" : undefined}>
						<Button
							onClick={() => goTo(DONE_STEP)}
							size={controlSize}
							type="button"
							variant="subtle"
							{...testId("pricing-configurator-thanks-done")}
						>
							<Trans>That's all, thanks</Trans>
						</Button>
						<Button
							onClick={() => goTo(String(OPENING_STEP + 1))}
							size={controlSize}
							type="button"
							{...testId("pricing-configurator-thanks-questions")}
						>
							<Trans>Sure</Trans>
						</Button>
					</Group>
				</Stack>
			)}

			{/* The reference is the guard, not a formality: the row is written and
			    the answers are saved before this step can render at all. */}
			{phase.kind === "book" && reference && (
				<PricingBookingStep
					host={asksEmail ? EventBookingHost : BookingHost}
					links={asksEmail ? EventBookingLinks : BookingLinks}
					showReference={!asksEmail}
					onBooked={handleBooked}
					onOpened={handleBookingOpened}
					onUnavailable={handleBookingUnavailable}
					prefill={prefill}
					reference={reference}
				/>
			)}

			{phase.kind === "done" && (
				<Stack
					gap="lg"
					style={fullScreen ? { flex: 1 } : undefined}
					{...testId("pricing-configurator-confirmation")}
				>
					{isConfirmed ? (
						// The time is shown in the modal title, not here: "Your call is
						// booked: {time}."
						<Text>
							<Trans>
								The invite is in your inbox. We will read your answers before
								then and bring a draft offer. Do you have any questions in the
								meantime? Reach out to
							</Trans>{" "}
							<Anchor
								href={supportMailto(reference ?? "")}
								{...testId("pricing-configurator-support-mail")}
							>
								info@dembrane.com
							</Anchor>
						</Text>
					) : asksEmail ? (
						<Text
							mt={fullScreen ? "auto" : undefined}
							style={{
								fontSize: "var(--app-heading-h2-size)",
								fontWeight: "var(--app-heading-font-weight, 300)",
								lineHeight: "var(--app-heading-h2-line-height)",
							}}
						>
							<Trans>
								We will be in touch within a day. Prefer to pick a time
								yourself?
							</Trans>
						</Text>
					) : (
						<Text>
							<Trans>
								Thanks for filling this in. Check your mail for the confirmation
								of the call. If you have any questions for us you can always
								contact us at info@dembrane.com
							</Trans>
						</Text>
					)}
					{!asksEmail && (
						<Text size="xs">
							<Trans>Reference {reference}</Trans>
						</Text>
					)}
					<Group justify="flex-end" mt={fullScreen ? "auto" : undefined}>
						<Button
							onClick={handleClose}
							size={controlSize}
							variant="subtle"
							{...testId("pricing-configurator-back-to-dembrane")}
						>
							{asksEmail ? (
								<Trans>Close</Trans>
							) : (
								<Trans>Back to dembrane</Trans>
							)}
						</Button>
						{asksEmail && !isConfirmed && (
							<Button
								onClick={() => goTo(BOOKING_STEP)}
								size={controlSize}
								type="button"
								{...testId("pricing-configurator-pick-a-time")}
							>
								<Trans>Pick a time now</Trans>
							</Button>
						)}
					</Group>
				</Stack>
			)}
		</Modal>
	);
};

/** The person's own timezone, from their own browser. */
const formatBookingTime = (startTime: string): string => {
	const date = new Date(startTime);
	if (Number.isNaN(date.getTime())) return startTime;
	return date.toLocaleString(undefined, {
		dateStyle: "full",
		timeStyle: "short",
	});
};

const QuestionBody = ({
	answers,
	headingId,
	headingRef,
	onAudioRetained,
	onOptionChanged,
	onOptionOpened,
	onSubmit,
	projectId,
	question,
	showExactError,
	touch,
	updateAnswers,
	voice,
}: {
	answers: Answers;
	headingId: string;
	headingRef: React.RefObject<HTMLHeadingElement | null>;
	onAudioRetained: (
		questionKey: string,
	) => (attachment: VoiceAttachment | null) => void;
	onOptionChanged: (
		action: "opened" | "selected" | "deselected" | "invalid",
		questionKey: QuestionKey,
		optionKey: string,
		extra?: Record<string, unknown>,
	) => void;
	onOptionOpened: (questionKey: QuestionKey, optionKey: string) => void;
	onSubmit: () => void;
	projectId?: string;
	question: Question;
	showExactError: boolean;
	/** Phone sizing: helper text one step up, example buttons full height. */
	touch: boolean;
	updateAnswers: (patch: Partial<Answers>) => void;
	/** Whether the free text boxes offer the record button. */
	voice: boolean;
}) => {
	// The rhythm is the onboarding questionnaire's, which is the app's other
	// question-per-step form: 4px between the question and its helper line, 12px
	// from there to the options, 8px between options, and `size="md"` controls.
	const heading = (
		<Stack gap="xs">
			{/* The question is the conversation; the options are labels. On the
			    portal the two sit further apart: h2 over the 16px options. */}
			<Title
				id={headingId}
				order={touch ? 2 : 4}
				ref={headingRef}
				tabIndex={-1}
			>
				{question.label}
			</Title>
			{question.hint && <Text size={touch ? "md" : "sm"}>{question.hint}</Text>}
		</Stack>
	);

	if (question.kind === "multi") {
		const selected =
			(question.key === "use_case" ? answers.use_case : answers.extras) ?? [];
		return (
			<Stack gap="md">
				{heading}
				<Checkbox.Group
					aria-labelledby={headingId}
					onChange={(next) => {
						const added = next.find((key) => !selected.includes(key));
						const removed = selected.find((key) => !next.includes(key));
						if (added) {
							const option = question.options.find((one) => one.key === added);
							if (option?.reveals) onOptionOpened(question.key, added);
							onOptionChanged("selected", question.key, added);
						}
						if (removed) onOptionChanged("deselected", question.key, removed);
						updateAnswers(
							question.key === "use_case"
								? { use_case: next }
								: { extras: next },
						);
					}}
					value={selected}
				>
					<Stack gap="sm">
						{question.options.map((option) => (
							<Box key={option.key}>
								<Checkbox
									description={option.description}
									label={option.label}
									onFocus={() => {
										if (option.reveals)
											onOptionOpened(question.key, option.key);
									}}
									size="md"
									value={option.key}
									{...testId(`pricing-option-${question.key}-${option.key}`)}
								/>
								{option.reveals === "text" && selected.includes(option.key) && (
									<Box mt="sm" pl="xl">
										<PricingTextInput
											allowVoice={voice}
											minRows={1}
											onAudioRetained={onAudioRetained("use_case_other")}
											onChange={(value) =>
												updateAnswers({ use_case_other: value })
											}
											onSubmit={onSubmit}
											placeholder={t`What is it?`}
											projectId={projectId}
											questionKey="use_case_other"
											testIdPrefix="pricing-use-case-other"
											value={answers.use_case_other ?? ""}
										/>
									</Box>
								)}
							</Box>
						))}
					</Stack>
				</Checkbox.Group>
				{/* The last step carries a free text box under its tickboxes, so the
				    form ends on one screen rather than two. It is a real answer with
				    a label of its own, which is what the booking summary reads. */}
				{question.follow && (
					<Stack gap="xs">
						<Text fw={500} id={`${headingId}-follow`}>
							{question.follow.label}
						</Text>
						<FreeTextAnswer
							answers={answers}
							ariaLabelledBy={`${headingId}-follow`}
							onAudioRetained={onAudioRetained}
							onOptionChanged={onOptionChanged}
							onSubmit={onSubmit}
							projectId={projectId}
							question={question.follow}
							touch={touch}
							updateAnswers={updateAnswers}
							voice={voice}
						/>
					</Stack>
				)}
			</Stack>
		);
	}

	if (question.kind === "single") {
		const isVolume = question.key === "volume";
		const value = (isVolume ? answers.volume : answers.concurrency) ?? "";
		return (
			<Stack gap="md">
				{heading}
				<Radio.Group
					aria-labelledby={headingId}
					onChange={(next) => {
						const option = question.options.find((one) => one.key === next);
						if (option?.reveals) onOptionOpened(question.key, next);
						// One choice, so picking a second one deselects the first. R13
						// wants that counted, not silently replaced.
						if (value && value !== next) {
							onOptionChanged("deselected", question.key, value);
						}
						onOptionChanged("selected", question.key, next);
						updateAnswers(
							isVolume
								? { volume: next }
								: { concurrency: next, concurrency_exact: undefined },
						);
					}}
					value={value}
				>
					<Stack gap="sm">
						{question.options.map((option) => (
							<Box key={option.key}>
								<Radio
									description={option.description}
									label={option.label}
									onFocus={() => {
										if (option.reveals)
											onOptionOpened(question.key, option.key);
									}}
									size="md"
									value={option.key}
									{...testId(`pricing-option-${question.key}-${option.key}`)}
								/>
								{option.reveals === "number" && value === option.key && (
									<Box mt="sm" pl="xl">
										<TextInput
											// One sentence, in two places it can never contradict
											// itself: the quiet helper under the box, and the same
											// words in red once the box holds "forty-ish".
											description={
												showExactError
													? undefined
													: t`A rough number or "not sure". Either is useful.`
											}
											error={
												showExactError
													? t`A rough number or "not sure". Either is useful.`
													: undefined
											}
											inputMode="numeric"
											label={t`Roughly how many?`}
											onChange={(event) =>
												updateAnswers({
													concurrency_exact: event.currentTarget.value,
												})
											}
											size="md"
											value={answers.concurrency_exact ?? ""}
											w={180}
											{...testId("pricing-concurrency-exact")}
										/>
									</Box>
								)}
							</Box>
						))}
					</Stack>
				</Radio.Group>
			</Stack>
		);
	}

	// Only the free text kind is left. The guard is what lets the compiler see
	// the examples, and it catches a fourth kind added to the question set.
	if (question.kind !== "text") return null;

	return (
		<Stack gap="md">
			{heading}
			<FreeTextAnswer
				answers={answers}
				ariaLabelledBy={headingId}
				onAudioRetained={onAudioRetained}
				onOptionChanged={onOptionChanged}
				onSubmit={onSubmit}
				projectId={projectId}
				question={question}
				updateAnswers={updateAnswers}
				voice={voice}
				touch={touch}
			/>
		</Stack>
	);
};

/** One free text answer: the composer, and the example chips under it.
 *
 * Both boxes that carry examples use it, the one with a step of its own and the
 * one that shares the last step, so a chip behaves the same in both places.
 * Tapping a chip fills the box, and the text can then be edited.
 *
 * Which example filled the box is remembered for the timing answer only. That
 * is the one the `config` object has a key for, and adding a second would move
 * the shape version, which this rewrite deliberately does not touch.
 */
const FreeTextAnswer = ({
	answers,
	ariaLabelledBy,
	onAudioRetained,
	onOptionChanged,
	onSubmit,
	projectId,
	question,
	touch,
	updateAnswers,
	voice,
}: {
	answers: Answers;
	ariaLabelledBy: string;
	onAudioRetained: (
		questionKey: string,
	) => (attachment: VoiceAttachment | null) => void;
	onOptionChanged: (
		action: "opened" | "selected" | "deselected" | "invalid",
		questionKey: QuestionKey,
		optionKey: string,
		extra?: Record<string, unknown>,
	) => void;
	onSubmit: () => void;
	projectId?: string;
	question: TextQuestion;
	touch: boolean;
	updateAnswers: (patch: Partial<Answers>) => void;
	voice: boolean;
}) => {
	const isTiming = question.key === "timing";
	return (
		<Stack gap="md">
			<PricingTextInput
				allowVoice={voice}
				ariaLabelledBy={ariaLabelledBy}
				onAudioRetained={onAudioRetained(question.key)}
				onChange={(value) =>
					updateAnswers(
						isTiming
							? { timing: value, timing_example: null }
							: { context: value },
					)
				}
				onSubmit={onSubmit}
				projectId={projectId}
				questionKey={question.key}
				testIdPrefix={`pricing-${question.key}`}
				value={(isTiming ? answers.timing : answers.context) ?? ""}
			/>
			{question.examples && (
				<Group gap="sm">
					{question.examples.map((example) => (
						<Button
							key={example.key}
							onClick={() => {
								onOptionChanged("selected", question.key, example.key);
								updateAnswers(
									isTiming
										? { timing: example.label, timing_example: example.key }
										: { context: example.label },
								);
							}}
							size={touch ? "md" : "compact-md"}
							type="button"
							variant="outline"
							{...testId(`pricing-${question.key}-example-${example.key}`)}
						>
							{example.label}
						</Button>
					))}
				</Group>
			)}
		</Stack>
	);
};
