import { afterEach } from "vitest";

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
