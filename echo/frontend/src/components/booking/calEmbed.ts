import { useCallback, useEffect, useRef, useState } from "react";
import { BookingLinks } from "@/lib/links";

/** The cal.com inline embed, as a hook, and the plain link when it does not come.
 *
 * Two places book a call with the same mechanics: the pricing configurator's
 * booking step ("discuss your needs") and the participant portal's closing card
 * ("plan an event"). They differ in the event type, the prefill and the words
 * around the calendar, so those are the caller's; everything cal.com needs to
 * land is here, once.
 *
 * The embed is the primary route and the plain link is a first class fallback,
 * not an error state. `embed.js` is loaded once for the page; each caller gets
 * its own namespace so two calendars never share a queue.
 *
 * The wait is 8 seconds. Measured on a cold load, `linkReady` arrives at about
 * 1.8 seconds, so 8 is generous rather than tight.
 */

export const CAL_ORIGIN = "https://app.cal.com";
export const EMBED_TIMEOUT_MS = 8000;

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

export type CalEmbedOptions = {
	/** The event type as the embed names it, e.g. `team/dembrane/plan-event`. */
	calLink: string;
	/** Keeps this embed's queue separate from any other embed on the page. */
	namespace: string;
	/** The id of the element the calendar renders into. */
	elementId: string;
	/** What cal.com is told, in its own prefill keys. Read through a ref, so a
	 * caller passing a fresh object on every render cannot remount the embed
	 * underneath the person. The layout is added here, last, so a prefill key
	 * can never take it with it. */
	prefill: Record<string, string>;
	onBooked: (booking: BookingSignal) => void;
	/** Which route the person actually got. */
	onOpened: (route: "embed" | "fallback_link") => void;
	onUnavailable: (reason: "timeout" | "blocked", secondsWaited: number) => void;
};

export const useCalEmbed = ({
	calLink,
	elementId,
	namespace,
	onBooked,
	onOpened,
	onUnavailable,
	prefill,
}: CalEmbedOptions): { isUnavailable: boolean } => {
	const [isUnavailable, setIsUnavailable] = useState(false);
	const openedAtRef = useRef(Date.now());
	const settledRef = useRef(false);
	const routeReportedRef = useRef(false);
	const bookedRef = useRef(false);

	const prefillRef = useRef(prefill);
	prefillRef.current = prefill;

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
			Cal("init", namespace, { origin: CAL_ORIGIN });
			Cal.ns?.[namespace]?.("inline", {
				calLink,
				config: { ...prefillRef.current, layout: "month_view" },
				elementOrSelector: `#${elementId}`,
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
	}, [
		calLink,
		elementId,
		handleBooking,
		namespace,
		onUnavailable,
		reportRoute,
	]);

	return { isUnavailable };
};
