// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAudienceTheme } from "./useAudienceTheme";

const STORAGE_KEY = "dembrane-present-theme";

const at = (search: string) => {
	window.history.replaceState(null, "", `/present/room${search}`);
};

afterEach(() => {
	cleanup();
	at("");
	window.localStorage.clear();
	vi.restoreAllMocks();
});

describe("the theme of the room's screen", () => {
	it("opens light when nothing says otherwise", () => {
		const { result } = renderHook(() => useAudienceTheme());
		expect(result.current[0]).toBe("light");
	});

	it("takes the theme a host handed out in the link over the one remembered", () => {
		window.localStorage.setItem(STORAGE_KEY, "dark");
		at("?theme=light");
		expect(renderHook(() => useAudienceTheme()).result.current[0]).toBe("light");
		cleanup();

		window.localStorage.setItem(STORAGE_KEY, "light");
		at("?theme=dark");
		expect(renderHook(() => useAudienceTheme()).result.current[0]).toBe("dark");
	});

	it("falls back to this browser's memory, and ignores a theme it cannot read", () => {
		window.localStorage.setItem(STORAGE_KEY, "dark");
		expect(renderHook(() => useAudienceTheme()).result.current[0]).toBe("dark");
		cleanup();

		at("?theme=midnight");
		expect(renderHook(() => useAudienceTheme()).result.current[0]).toBe("dark");
		cleanup();

		window.localStorage.setItem(STORAGE_KEY, "midnight");
		at("");
		expect(renderHook(() => useAudienceTheme()).result.current[0]).toBe("light");
	});

	it("remembers the switch for the next room on this browser", () => {
		const { result } = renderHook(() => useAudienceTheme());
		act(() => result.current[1]("dark"));
		expect(result.current[0]).toBe("dark");
		expect(window.localStorage.getItem(STORAGE_KEY)).toBe("dark");

		act(() => result.current[1]("light"));
		expect(window.localStorage.getItem(STORAGE_KEY)).toBe("light");
	});

	it("works in a window where storage throws", () => {
		const blocked = () => {
			throw new Error("access denied");
		};
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(blocked);
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(blocked);

		const { result } = renderHook(() => useAudienceTheme());
		expect(result.current[0]).toBe("light");
		act(() => result.current[1]("dark"));
		expect(result.current[0]).toBe("dark");
	});
});
