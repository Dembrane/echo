// PostHog exception autocapture picks up errors thrown by scripts that in-app
// mobile browsers and extensions inject into the page (the "Script error." and
// window.__firefox__ family). Their only stack frame points at the HTML
// document itself, never at one of our bundled /assets/*.js chunks, so they are
// noise we can drop before it reaches error tracking. Real portal crashes keep
// frames that resolve to script assets and pass through untouched.

import type { CaptureResult } from "posthog-js";

interface StackFrame {
	filename?: string;
}

interface CapturedException {
	stacktrace?: {
		frames?: StackFrame[];
	};
}

// A frame belongs to the HTML document (not a script asset) when its filename
// resolves to the same origin and path as the current page.
const isDocumentFrame = (filename?: string): boolean => {
	if (!filename) return false;
	try {
		const frameUrl = new URL(filename, window.location.href);
		return (
			frameUrl.origin === window.location.origin &&
			frameUrl.pathname === window.location.pathname
		);
	} catch {
		return false;
	}
};

// Drops an $exception event whose every frame points at the document URL.
// Anything else, including events with no stack frames, passes through.
export const dropInjectedScriptExceptions = (
	event: CaptureResult | null,
): CaptureResult | null => {
	if (!event || event.event !== "$exception") return event;

	const exceptions = event.properties?.$exception_list as
		| CapturedException[]
		| undefined;
	if (!Array.isArray(exceptions)) return event;

	const frames = exceptions.flatMap(
		(exception) => exception?.stacktrace?.frames ?? [],
	);
	if (frames.length === 0) return event;

	const everyFrameIsDocument = frames.every((frame) =>
		isDocumentFrame(frame?.filename),
	);
	return everyFrameIsDocument ? null : event;
};
