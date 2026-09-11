import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Box, Button, Stack, Text } from "@mantine/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookingHost, BookingLinks } from "@/lib/links";
import { testId } from "@/lib/testUtils";
import { bookingLinkWithPrefill } from "./bookingPrefill";

/** The booking step: the cal.com embed, and the plain link when it does not come.
 *
 * The embed is the primary route and the plain link is a first class fallback,
 * not an error state. Today the frontend CSP lists cal.com in none of
 * `frame-src`, `script-src` or `connect-src`, so every person lands on the
 * fallback until that changes. That is expected, and the screen says something
 * true either way because the row is written before this step renders.
 *
 * The wait is 8 seconds. Measured on a cold load, `linkReady` arrives at about
 * 1.8 seconds, so 8 is generous rather than tight.
 *
 * Both routes carry the answers. The embed gets them in its `config`, the plain
 * link gets the same map on its query string. See `bookingPrefill.ts` for the
 * keys and where each one is documented.
 */

const CAL_ORIGIN = "https://app.cal.com";
const EMBED_TIMEOUT_MS = 8000;
const EMBED_ELEMENT_ID = "dembrane-cal-booking";

export type BookingSignal = {
	signal: "postmessage" | "redirect";
	/** cal.com's own booking status. Only `accepted` earns "your call is booked". */
	status: string | null;
	startTime: string | null;
	secondsAfterOpen: number;
	/** cal.com's own id for the booking. It is the one value that joins their
	 * record to ours, so it travels up and lands on the row. Null when the
	 * payload carried none, and then there is nothing to report. */
	uid: string | null;
};

/** One queued call: the arguments exactly as they were passed. */
type CalCall = unknown[];

type CalNamespaceApi = ((...args: unknown[]) => void) & { q?: CalCall[] };

type CalApi = ((...args: unknown[]) => void) & {
	/** cal.com's own flag: the embed script has been asked for. */
	loaded?: boolean;
	q?: CalCall[];
	ns?: Record<string, CalNamespaceApi>;
};

const calApi = (): CalApi | undefined =>
	(globalThis as { Cal?: CalApi }).Cal ?? undefined;

const queue = (target: { q?: CalCall[] }, args: CalCall) => {
	target.q = target.q ?? [];
	target.q.push(args);
};

const makeNamespaceApi = (): CalNamespaceApi => {
	const api: CalNamespaceApi = (...args: unknown[]) => queue(api, args);
	api.q = [];
	return api;
};

/** cal.com's own inline queue stub, from
 * https://cal.com/docs/developing/guides/embeds, and quoted in `@/lib/links`.
 *
 * It defines `window.Cal` synchronously and pushes every call onto a queue that
 * embed.js drains when it arrives. This is the fix for `Uncaught Error: Cal is
 * not defined`: the step used to append embed.js and then
 * call `Cal(...)` from the script's own `load` handler, so a call that beat the
 * script threw from inside an event handler, where the `try` below could never
 * reach it. With the stub there is no window in which `Cal` does not exist.
 *
 * One deliberate difference from cal.com's published snippet: appending
 * embed.js is left to the effect rather than done inside the stub. The script's
 * `load` event is the only honest signal that the embed really arrived, and
 * both the route report and the fallback rest on it, so the effect keeps the
 * element. Everything the fix depends on, defining `Cal` and queueing, is the
 * snippet unchanged.
 */
const installCalStub = (): CalApi => {
	const existing = calApi();
	if (existing) return existing;
	const scope = globalThis as { Cal?: CalApi };

	const cal: CalApi = (...args: unknown[]) => {
		if (!cal.loaded) {
			cal.ns = {};
			cal.q = [];
			cal.loaded = true;
		}
		const namespace = args[1];
		if (args[0] === "init" && typeof namespace === "string") {
			const ns = cal.ns ?? {};
			cal.ns = ns;
			const api = ns[namespace] ?? makeNamespaceApi();
			ns[namespace] = api;
			queue(api, args);
			queue(cal, ["initNamespace", namespace]);
			return;
		}
		queue(cal, args);
	};

	scope.Cal = cal;
	return cal;
};

/** Pull the three fields out of a payload whose exact shape cal.com owns.
 *
 * Two of them are what the confirmation reads. The third, `uid`, is what the
 * row learns: it is cal.com's own id for the booking, so a row and a booking
 * can be read as one thing afterwards.
 *
 * Everything is optional on purpose: a missing status is read as "not
 * accepted", which is the safe side, and a missing uid means nothing is
 * reported rather than a row learning a blank.
 */
const readBooking = (
	payload: unknown,
): { status: string | null; startTime: string | null; uid: string | null } => {
	if (typeof payload !== "object" || payload === null) {
		return { startTime: null, status: null, uid: null };
	}
	const record = payload as Record<string, unknown>;
	const nested =
		typeof record.booking === "object" && record.booking !== null
			? (record.booking as Record<string, unknown>)
			: {};
	const status = record.status ?? nested.status;
	const startTime = record.startTime ?? nested.startTime ?? record.date;
	const uid = record.uid ?? nested.uid;
	return {
		startTime: typeof startTime === "string" ? startTime : null,
		status: typeof status === "string" ? status : null,
		uid: typeof uid === "string" && uid.trim() !== "" ? uid : null,
	};
};

/** The name the two booking lines say.
 *
 * `BookingHost` is the one source, and null is a supported state: with no host
 * the screen says "the dembrane team".
 *
 * Call it during a render. A `t` macro at module scope freezes the string
 * before a locale is active.
 */
export const bookingHostName = (): string =>
	BookingHost?.name ?? t`the dembrane team`;

export const PricingBookingStep = ({
	onBooked,
	onOpened,
	onUnavailable,
	prefill,
	reference,
}: {
	onBooked: (booking: BookingSignal) => void;
	/** Which route the person actually got. */
	onOpened: (route: "embed" | "fallback_link") => void;
	onUnavailable: (reason: "timeout" | "blocked", secondsWaited: number) => void;
	/** The reference and the plain summary, in cal.com's own prefill keys. */
	prefill: Record<string, string>;
	reference: string;
}) => {
	const [isUnavailable, setIsUnavailable] = useState(false);
	const openedAtRef = useRef(Date.now());
	const settledRef = useRef(false);
	const routeReportedRef = useRef(false);
	const bookedRef = useRef(false);

	// Read through a ref so a caller passing a fresh object on every render
	// cannot remount the embed underneath the person.
	const prefillRef = useRef(prefill);
	prefillRef.current = prefill;

	const fallbackHref = useMemo(
		() => bookingLinkWithPrefill(BookingLinks.BOOK_A_CALL, prefill),
		[prefill],
	);

	const reportRoute = useCallback(
		(route: "embed" | "fallback_link") => {
			if (routeReportedRef.current) return;
			routeReportedRef.current = true;
			onOpened(route);
		},
		[onOpened],
	);

	const handleBooking = useCallback(
		(payload: unknown) => {
			if (bookedRef.current) return;
			bookedRef.current = true;
			const { startTime, status, uid } = readBooking(payload);
			onBooked({
				secondsAfterOpen: Math.round((Date.now() - openedAtRef.current) / 1000),
				signal: "postmessage",
				startTime,
				status,
				uid,
			});
		},
		[onBooked],
	);

	// The raw channel. The origin and the originator are both checked, because
	// any page can post a message at this window.
	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			if (event.origin !== CAL_ORIGIN) return;
			const data = event.data as
				| { originator?: string; type?: string; data?: unknown }
				| undefined;
			if (data?.originator !== "CAL") return;
			settledRef.current = true;
			if (data.type === "bookingSuccessfulV2") handleBooking(data.data);
		};
		globalThis.addEventListener("message", onMessage);
		return () => globalThis.removeEventListener("message", onMessage);
	}, [handleBooking]);

	// The embed. The script is appended once; the CSP decides whether it lands.
	useEffect(() => {
		const openedAt = openedAtRef.current;
		let cancelled = false;

		// The stub first, so `Cal` exists before anything calls it. The three
		// calls below then run against the real API when embed.js is already
		// here, and are queued for it when it is not.
		try {
			const Cal = installCalStub();
			Cal("init", BookingLinks.EMBED_NAMESPACE, { origin: CAL_ORIGIN });
			Cal.ns?.[BookingLinks.EMBED_NAMESPACE]?.("inline", {
				calLink: BookingLinks.CAL_LINK,
				// The prefill rides in the same `config` the layout does. Our own
				// keys go last so a prefill key can never take the layout with it.
				config: { ...prefillRef.current, layout: "month_view" },
				elementOrSelector: `#${EMBED_ELEMENT_ID}`,
			});
			Cal("on", {
				action: "bookingSuccessfulV2",
				callback: (event: { detail?: { data?: unknown } }) => {
					settledRef.current = true;
					handleBooking(event?.detail?.data);
				},
			});
		} catch {
			// A changed API must not take the step with it. The timer below still
			// turns this into the fallback.
		}

		// The script, and its `load` is the one honest signal that the embed
		// really arrived. A stub that queues forever is not something a person
		// can see, so the route is reported here and nowhere else.
		let script = document.querySelector<HTMLScriptElement>(
			`script[src="${BookingLinks.EMBED_SCRIPT}"]`,
		);
		if (!script) {
			const created = document.createElement("script");
			created.async = true;
			created.src = BookingLinks.EMBED_SCRIPT;
			// The marker outlives this effect on purpose: a step that mounts again
			// after the script landed must not sit out the eight seconds waiting
			// for a `load` event that already fired.
			created.addEventListener(
				"load",
				() => {
					created.dataset.calEmbedLoaded = "true";
				},
				{ once: true },
			);
			document.head.appendChild(created);
			script = created;
		}
		const element = script;
		const announceEmbed = () => {
			if (cancelled) return;
			reportRoute("embed");
		};
		if (element.dataset.calEmbedLoaded === "true") announceEmbed();
		else element.addEventListener("load", announceEmbed);

		const timer = setTimeout(() => {
			if (cancelled || settledRef.current) return;
			setIsUnavailable(true);
			reportRoute("fallback_link");
			onUnavailable("timeout", Math.round((Date.now() - openedAt) / 1000));
		}, EMBED_TIMEOUT_MS);

		return () => {
			cancelled = true;
			clearTimeout(timer);
			element.removeEventListener("load", announceEmbed);
		};
	}, [handleBooking, onUnavailable, reportRoute]);

	if (isUnavailable) {
		// The screen is true rather than reassuring: the row is written before
		// this step renders, so the answers really are kept whether or not the
		// person ever books.
		//
		// The button stays, and it is the whole point of the screen: without it a
		// person who wants a call has no way to book one, because the embed is
		// exactly what did not load. The plain link carries the same answers on
		// its query string.
		//
		// This screen carries its own thank you line rather than a heading, so
		// the modal drops the step title while it is up. Naming a host above a
		// calendar that did not load would be a second untrue thing on the
		// screen.
		return (
			<Stack gap="lg" {...testId("pricing-configurator-booking-fallback")}>
				<Text>
					<Trans>
						Thank you! We will get in touch as soon as possible. You can also
						write to us at info@dembrane.com.
					</Trans>
				</Text>
				<Text fw={500} {...testId("pricing-configurator-booking-reference")}>
					<Trans>Reference {reference}</Trans>
				</Text>
				<Box>
					<Button
						component="a"
						href={fallbackHref}
						rel="noreferrer"
						size="md"
						target="_blank"
						{...testId("pricing-configurator-booking-link")}
					>
						<Trans>Pick a time</Trans>
					</Button>
				</Box>
			</Stack>
		);
	}

	// The doubled "Pick a time. Please pick a time..." is gone. The modal title
	// says who the call is with, and this says what they will do with the
	// answers before it.
	const host = bookingHostName();

	return (
		<Stack gap="lg" {...testId("pricing-configurator-booking")}>
			<Text size="sm">
				<Trans>
					{host} will read your answers before the call and brings a draft
					offer.
				</Trans>
			</Text>
			<Box id={EMBED_ELEMENT_ID} mih={480} />
			<Text size="xs">
				<Trans>Reference {reference}</Trans>
			</Text>
		</Stack>
	);
};
