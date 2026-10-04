// @vitest-environment jsdom
import { MantineProvider } from "@mantine/core";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { roomColorSchemeManager, useAudienceTheme } from "./useAudienceTheme";

// The app's own key: the room's switch is the app's theme.
const STORAGE_KEY = "mantine-color-scheme-value";

const at = (search: string) => {
	window.history.replaceState(null, "", `/present/room${search}`);
};

const room = ({ children }: { children: ReactNode }) =>
	createElement(
		MantineProvider,
		{ colorSchemeManager: roomColorSchemeManager, defaultColorScheme: "light" },
		children,
	);

const openTheme = () =>
	renderHook(() => useAudienceTheme(), { wrapper: room }).result.current[0];

// The laptop's operating system is in dark mode throughout: the room never asks it.
beforeEach(() => {
	vi.stubGlobal(
		"matchMedia",
		vi.fn().mockReturnValue({
			addEventListener: vi.fn(),
			matches: true,
			removeEventListener: vi.fn(),
		}),
	);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	at("");
	window.localStorage.clear();
	vi.restoreAllMocks();
});

describe("the theme of the room's screen", () => {
	it("opens light when nothing says otherwise", () => {
		expect(openTheme()).toBe("light");
	});

	it("never follows the operating system: the app's System opens light", () => {
		window.localStorage.setItem(STORAGE_KEY, "auto");
		expect(openTheme()).toBe("light");
	});

	it("takes the theme a host handed out in the link over the one remembered", () => {
		window.localStorage.setItem(STORAGE_KEY, "dark");
		at("?theme=light");
		expect(openTheme()).toBe("light");
		cleanup();

		window.localStorage.setItem(STORAGE_KEY, "light");
		at("?theme=dark");
		expect(openTheme()).toBe("dark");
	});

	it("falls back to the app's theme, and ignores a theme it cannot read", () => {
		window.localStorage.setItem(STORAGE_KEY, "dark");
		expect(openTheme()).toBe("dark");
		cleanup();

		at("?theme=midnight");
		expect(openTheme()).toBe("dark");
	});

	it("sets the app's theme for this browser when switched", () => {
		const { result } = renderHook(() => useAudienceTheme(), { wrapper: room });
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

		const { result } = renderHook(() => useAudienceTheme(), { wrapper: room });
		expect(result.current[0]).toBe("light");
		act(() => result.current[1]("dark"));
		expect(result.current[0]).toBe("dark");
	});
});
