import type { BeforeSendFn } from "posthog-js";

type ExceptionEntry = { type?: string; value?: string };

// Axios raises "Network Error" when the browser loses the connection before a
// response arrives. Upload code can prefix the message, so match the suffix.
const isNetworkFault = (entry: ExceptionEntry) =>
	entry.type === "AxiosError" && (entry.value ?? "").endsWith("Network Error");

/** Drops `$exception` events that only hold browser-side network faults. */
export const dropNetworkFaultExceptions: BeforeSendFn = (event) => {
	if (event?.event !== "$exception") return event;
	const exceptions = event.properties.$exception_list as
		| ExceptionEntry[]
		| undefined;
	if (exceptions?.length && exceptions.every(isNetworkFault)) return null;
	return event;
};
