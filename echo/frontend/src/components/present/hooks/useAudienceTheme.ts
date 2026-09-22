import { useCallback, useState } from "react";

export type AudienceTheme = "light" | "dark";

// Per browser, not per presentation: the same laptop drives the same projector
// through one room after another.
const STORAGE_KEY = "dembrane-present-theme";

const isTheme = (value: unknown): value is AudienceTheme =>
	value === "light" || value === "dark";

function read(): AudienceTheme | null {
	if (typeof window === "undefined") return null;
	try {
		const stored = window.localStorage.getItem(STORAGE_KEY);
		return isTheme(stored) ? stored : null;
	} catch {
		// A private window: the screen works without a memory.
		return null;
	}
}

function write(theme: AudienceTheme): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(STORAGE_KEY, theme);
	} catch {
		// No room to write, or a private window: the choice lasts this visit.
	}
}

// The address wins, so a host can hand out a dark link and the room opens dark
// whatever this browser remembers. The operating system is never asked: a
// projector laptop in dark mode must not surprise a room.
function initial(): AudienceTheme {
	if (typeof window === "undefined") return "light";
	const asked = new URLSearchParams(window.location.search).get("theme");
	return isTheme(asked) ? asked : (read() ?? "light");
}

/** The theme of this screen, switched on the screen itself. */
export function useAudienceTheme(): [
	AudienceTheme,
	(theme: AudienceTheme) => void,
] {
	const [theme, setTheme] = useState<AudienceTheme>(initial);
	const choose = useCallback((next: AudienceTheme) => {
		setTheme(next);
		write(next);
	}, []);
	return [theme, choose];
}
