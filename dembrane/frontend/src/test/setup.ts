import { afterEach } from "vitest";

// Testing Library sets these up itself only when beforeAll/afterEach are
// globals, and this suite runs without vitest globals.

// Without the flag React warns on every act(): "The current testing
// environment is not configured to support act(...)".
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Node-environment tests have no DOM, so they skip loading Testing Library.
if (typeof document !== "undefined") {
	const { cleanup } = await import("@testing-library/react");
	afterEach(cleanup);

	// jsdom leaves scrollTo unimplemented and logs each call.
	window.scrollTo = () => {};
}
