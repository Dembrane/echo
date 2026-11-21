// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const chunkError = new Error("Failed to fetch dynamically imported module");
vi.mock("./routes/ParticipantPostConversation", () => {
	throw chunkError;
});
vi.mock("./components/refine/RefineSelection", () => {
	throw chunkError;
});

const { failedImportUrl, openLaterScreen } = await import("./laterScreens");

const reload = vi.fn();
beforeEach(() => {
	window.sessionStorage.clear();
	reload.mockReset();
	Object.defineProperty(window, "location", {
		configurable: true,
		value: { ...window.location, reload },
	});
});
afterEach(() => vi.restoreAllMocks());

it("reads the module address from Chromium and Firefox messages", () => {
	expect(
		failedImportUrl(
			new Error(
				"Failed to fetch dynamically imported module: https://portal.example/assets/Refine-a1.js",
			),
		),
	).toBe("https://portal.example/assets/Refine-a1.js");
	expect(
		failedImportUrl(
			new TypeError(
				"error loading dynamically imported module: https://portal.example/assets/Refine-a1.js",
			),
		),
	).toBe("https://portal.example/assets/Refine-a1.js");
	expect(
		failedImportUrl(new TypeError("Importing a module script failed.")),
	).toBeNull();
});

it("finish reloads the page once when its chunk will not load", async () => {
	const pending = openLaterScreen("finish");
	await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
	const settled = await Promise.race([
		pending.then(() => "settled"),
		new Promise((r) => setTimeout(() => r("pending"), 50)),
	]);
	expect(settled).toBe("pending");

	// A second failure inside a minute shows the error instead of looping.
	await expect(openLaterScreen("finish")).rejects.toBeDefined();
	expect(reload).toHaveBeenCalledTimes(1);
});

it("refine never reloads, so a live recording keeps running", async () => {
	await expect(openLaterScreen("refine")).rejects.toBeDefined();
	expect(reload).not.toHaveBeenCalled();
});

it("does not reload while offline", async () => {
	vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
	await expect(openLaterScreen("finish")).rejects.toBeDefined();
	expect(reload).not.toHaveBeenCalled();
});
