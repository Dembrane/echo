// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const CURRENT_BUILD = "build-current";

vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));

const reload = vi.fn();

/** Fresh module per test: the guards and throttle are module state. */
const loadModule = async () => {
	vi.resetModules();
	return import("./appVersion");
};

const mockVersionEndpoint = (buildId: string) => {
	const fetchMock = vi.fn().mockResolvedValue({
		json: async () => ({ buildId }),
		ok: true,
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
};

const mockUnreadableVersionEndpoint = () => {
	const fetchMock = vi.fn().mockRejectedValue(new Error("network"));
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
};

/** Stand-in for the react-router data router's subscribe API. */
const fakeRouter = (pathname: string) => {
	const subscribers: Array<
		(state: { location: { pathname: string } }) => void
	> = [];
	return {
		navigate: (to: string) => {
			for (const fn of subscribers) fn({ location: { pathname: to } });
		},
		state: { location: { pathname } },
		subscribe: (fn: (state: { location: { pathname: string } }) => void) => {
			subscribers.push(fn);
			return () => {};
		},
	};
};

beforeEach(() => {
	sessionStorage.clear();
	reload.mockClear();
	// Re-stubbed per test: `define` supplies the real sha, unstubAllGlobals restores it.
	vi.stubGlobal("__APP_BUILD_ID__", CURRENT_BUILD);
	vi.stubEnv("DEV", false as never);
	Object.defineProperty(window, "location", {
		configurable: true,
		value: { ...window.location, reload },
	});
	Object.defineProperty(navigator, "onLine", {
		configurable: true,
		value: true,
	});
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

// --- reactive path ---

it("reloads when a chunk fails and a newer deploy is serving", async () => {
	mockVersionEndpoint("build-newer");
	const { recoverFromChunkFailure } = await loadModule();

	await recoverFromChunkFailure();
	expect(reload).toHaveBeenCalledTimes(1);
});

it("leaves a healthy tab alone when the chunk failure was not a new deploy", async () => {
	// A dropped background prefetch looks exactly like a deleted chunk.
	mockVersionEndpoint(CURRENT_BUILD);
	const { recoverFromChunkFailure } = await loadModule();

	await recoverFromChunkFailure();
	expect(reload).not.toHaveBeenCalled();
});

it("does not consume the guard when it declines to reload", async () => {
	mockVersionEndpoint(CURRENT_BUILD);
	const { recoverFromChunkFailure } = await loadModule();

	await recoverFromChunkFailure();

	mockVersionEndpoint("build-newer");
	await recoverFromChunkFailure();
	expect(reload).toHaveBeenCalledTimes(1);
});

it("takes one guarded reload when the manifest cannot be read", async () => {
	mockUnreadableVersionEndpoint();
	const { recoverFromChunkFailure } = await loadModule();

	await recoverFromChunkFailure();
	expect(reload).toHaveBeenCalledTimes(1);

	await recoverFromChunkFailure();
	expect(reload).toHaveBeenCalledTimes(1);
});

it("dedupes concurrent failures from the idle prefetch burst", async () => {
	const fetchMock = mockVersionEndpoint(CURRENT_BUILD);
	const { recoverFromChunkFailure } = await loadModule();

	await Promise.all([
		recoverFromChunkFailure(),
		recoverFromChunkFailure(),
		recoverFromChunkFailure(),
	]);
	expect(fetchMock).toHaveBeenCalledTimes(1);
});

// --- guard ---

it("reloads at most once per target build", async () => {
	const { reloadForNewVersion } = await loadModule();

	expect(reloadForNewVersion("new_version_detected", "build-b")).toBe(true);
	expect(reloadForNewVersion("new_version_detected", "build-b")).toBe(false);
	expect(reload).toHaveBeenCalledTimes(1);
});

it("stays armed for the next deploy after an earlier reload", async () => {
	const { reloadForNewVersion } = await loadModule();

	expect(reloadForNewVersion("new_version_detected", "build-b")).toBe(true);
	expect(reloadForNewVersion("new_version_detected", "build-c")).toBe(true);
	expect(reload).toHaveBeenCalledTimes(2);
});

it("caps total reloads per session against a manifest serving rotating ids", async () => {
	const { reloadForNewVersion } = await loadModule();

	for (const target of ["b", "c", "d", "e", "f"]) {
		reloadForNewVersion("new_version_detected", target);
	}
	expect(reload).toHaveBeenCalledTimes(3);
});

it("refuses to reload when sessionStorage is unavailable", async () => {
	vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
		throw new Error("blocked");
	});
	const { reloadForNewVersion } = await loadModule();

	expect(reloadForNewVersion("new_version_detected", "build-b")).toBe(false);
	expect(reload).not.toHaveBeenCalled();
});

it("declines to reload while offline", async () => {
	Object.defineProperty(navigator, "onLine", {
		configurable: true,
		value: false,
	});
	const { reloadForNewVersion } = await loadModule();

	expect(reloadForNewVersion("chunk_load_failed", "build-b")).toBe(false);
	expect(reload).not.toHaveBeenCalled();
});

// --- proactive path ---

it("reloads on navigation once the server serves a newer build", async () => {
	mockVersionEndpoint("build-newer");
	const { watchForNewVersion } = await loadModule();

	watchForNewVersion(fakeRouter("/en-US/login"));
	await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
});

it("leaves the tab alone when the server serves the running build", async () => {
	mockVersionEndpoint(CURRENT_BUILD);
	const { watchForNewVersion } = await loadModule();

	watchForNewVersion(fakeRouter("/en-US/login"));
	await Promise.resolve();
	expect(reload).not.toHaveBeenCalled();
});

it("does not refetch the manifest on every navigation", async () => {
	const fetchMock = mockVersionEndpoint(CURRENT_BUILD);
	const { watchForNewVersion } = await loadModule();
	const router = fakeRouter("/en-US/login");

	watchForNewVersion(router);
	router.navigate("/en-US/projects");
	router.navigate("/en-US/settings");

	await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
});

// --- chunk-error message class ---

it("recognises the stale-deploy chunk-error messages across browsers", async () => {
	const { isChunkLoadErrorMessage } = await loadModule();

	expect(
		isChunkLoadErrorMessage(
			"Unable to preload CSS for /assets/WorkspaceSelectorRoute-abc123.css",
		),
	).toBe(true);
	expect(
		isChunkLoadErrorMessage(
			"Failed to fetch dynamically imported module: https://app/assets/Route-x.js",
		),
	).toBe(true);
	expect(
		isChunkLoadErrorMessage(
			"error loading dynamically imported module: https://app/assets/Route-x.js",
		),
	).toBe(true);
	expect(isChunkLoadErrorMessage("Importing a module script failed.")).toBe(
		true,
	);
});

it("leaves unrelated exceptions untouched", async () => {
	const { isChunkLoadErrorMessage } = await loadModule();

	expect(isChunkLoadErrorMessage("TypeError: x is not a function")).toBe(false);
	expect(isChunkLoadErrorMessage(undefined)).toBe(false);
	expect(isChunkLoadErrorMessage(null)).toBe(false);
});

// --- dev ---

it("is inert in dev, where no manifest is emitted", async () => {
	vi.stubEnv("DEV", true as never);
	const fetchMock = mockVersionEndpoint("build-newer");
	const { watchForNewVersion, recoverFromChunkFailure } = await loadModule();

	watchForNewVersion(fakeRouter("/en-US/login"));
	await recoverFromChunkFailure();

	expect(fetchMock).not.toHaveBeenCalled();
	expect(reload).not.toHaveBeenCalled();
});
