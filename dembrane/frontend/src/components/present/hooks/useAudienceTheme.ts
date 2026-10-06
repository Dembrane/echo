import {
	localStorageColorSchemeManager,
	type MantineColorSchemeManager,
	useComputedColorScheme,
	useMantineColorScheme,
} from "@mantine/core";

export type AudienceTheme = "light" | "dark";

const isTheme = (value: unknown): value is AudienceTheme =>
	value === "light" || value === "dark";

// The address wins, so a host can hand out a dark link and the room opens dark
// whatever this browser remembers.
function asked(): AudienceTheme | null {
	if (typeof window === "undefined") return null;
	const theme = new URLSearchParams(window.location.search).get("theme");
	return isTheme(theme) ? theme : null;
}

const remembered = localStorageColorSchemeManager();

/**
 * The room's screen keeps the app's own light or dark (per browser: the same
 * laptop drives the same projector through one room after another), with two
 * differences: a theme in the link opens the screen in it, and the operating
 * system is never asked. "System" opens light, because a projector laptop in
 * dark mode must not surprise a room.
 */
export const roomColorSchemeManager: MantineColorSchemeManager = {
	...remembered,
	get: (fallback) => {
		const theme = asked() ?? remembered.get(fallback);
		return theme === "auto" ? "light" : theme;
	},
};

/** The theme of this screen, switched on the screen itself: the switch sets
 * the app's theme, here and everywhere else in this browser. */
export function useAudienceTheme(): [
	AudienceTheme,
	(theme: AudienceTheme) => void,
] {
	const { setColorScheme } = useMantineColorScheme();
	return [useComputedColorScheme("light"), setColorScheme];
}
