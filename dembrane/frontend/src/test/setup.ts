import { afterEach } from "vitest";
import failOnConsole from "vitest-fail-on-console";

// A test that logs an error or warning fails, so React's warnings (invalid
// DOM nesting, act, keys) are fixed instead of scrolling past in CI. A test
// that logs on purpose spies on console and checks the message.
failOnConsole();

// Testing Library registers cleanup itself only when afterEach is a global,
// and this suite runs without vitest globals. Node-environment tests have no
// DOM, so they skip loading Testing Library.
//
// IS_REACT_ACT_ENVIRONMENT stays unset: Testing Library turns it on around its
// own act() calls, and setting it for the whole run makes React warn on every
// update a test doesn't wrap in act (about 500 across the suite today).
if (typeof document !== "undefined") {
	const { cleanup } = await import("@testing-library/react");
	afterEach(cleanup);

	// jsdom leaves scrollTo unimplemented and logs each call.
	window.scrollTo = () => {};
}
