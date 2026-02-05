import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useState,
} from "react";

export type FontFamily = "dm-sans" | "space-grotesk";

type AppPreferences = {
	fontFamily: FontFamily;
};

type AppPreferencesContextType = {
	preferences: AppPreferences;
	setFontFamily: (font: FontFamily) => void;
};

const defaultPreferences: AppPreferences = {
	fontFamily: "dm-sans",
};

// Changed key to reset existing users to new DM Sans default
const STORAGE_KEY = "dembrane-app-preferences-v2";

const AppPreferencesContext = createContext<AppPreferencesContextType | null>(
	null,
);

const isValidFontFamily = (value: string): value is FontFamily => {
	return value === "dm-sans" || value === "space-grotesk";
};

const getThemeFromUrl = (): FontFamily | null => {
	try {
		const params = new URLSearchParams(window.location.search);
		const theme = params.get("theme");
		if (theme && isValidFontFamily(theme)) {
			return theme;
		}
	} catch {
		// Ignore URL parsing errors
	}
	return null;
};

const loadPreferences = (): AppPreferences => {
	// First check URL for theme parameter (used in participant portal links)
	const urlTheme = getThemeFromUrl();
	if (urlTheme) {
		return { ...defaultPreferences, fontFamily: urlTheme };
	}

	// Fall back to localStorage
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored) {
			return { ...defaultPreferences, ...JSON.parse(stored) };
		}
	} catch {
		// Ignore parsing errors
	}
	return defaultPreferences;
};

const savePreferences = (prefs: AppPreferences) => {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
	} catch {
		// Ignore storage errors
	}
};

export const AppPreferencesProvider = ({
	children,
}: {
	children: ReactNode;
}) => {
	const [preferences, setPreferences] =
		useState<AppPreferences>(loadPreferences);

	const setFontFamily = (font: FontFamily) => {
		setPreferences((prev) => {
			const updated = { ...prev, fontFamily: font };
			savePreferences(updated);
			return updated;
		});
	};

	// Apply font and linked color scheme to document
	useEffect(() => {
		const isDmSans = preferences.fontFamily === "dm-sans";

		// Font
		const fontValue = isDmSans
			? "'DM Sans Variable', sans-serif"
			: "'Space Grotesk Variable', sans-serif";

		// Font feature settings for stylistic sets (ss01-ss06, ss08)
		const fontFeatureSettings = isDmSans
			? "'ss01' on, 'ss02' on, 'ss03' on, 'ss04' on, 'ss05' on, 'ss06' on, 'ss08' on"
			: "normal";

		// Colors linked to font choice
		// DM Sans → Parchment + Graphite
		// Space Grotesk → White + Black
		const backgroundColor = isDmSans ? "#F6F4F1" : "#FFFFFF";
		const textColor = isDmSans ? "#2D2D2C" : "#000000";

		// Set our custom CSS variables
		document.documentElement.style.setProperty("--app-font-family", fontValue);
		document.documentElement.style.setProperty(
			"--app-background",
			backgroundColor,
		);
		document.documentElement.style.setProperty("--app-text", textColor);

		// Override Mantine's CSS variables so components using them update dynamically
		document.documentElement.style.setProperty(
			"--mantine-color-white",
			backgroundColor,
		);
		document.documentElement.style.setProperty(
			"--mantine-color-black",
			textColor,
		);
		document.documentElement.style.setProperty(
			"--mantine-color-text",
			textColor,
		);
		document.documentElement.style.setProperty(
			"--mantine-color-body",
			backgroundColor,
		);

		// Apply to body
		document.body.style.fontFamily = fontValue;
		document.body.style.backgroundColor = backgroundColor;
		document.body.style.color = textColor;
		document.body.style.fontFeatureSettings = fontFeatureSettings;

		// Set CSS variable for font feature settings
		document.documentElement.style.setProperty(
			"--app-font-feature-settings",
			fontFeatureSettings,
		);

		// Set data attribute for potential CSS selectors
		document.documentElement.setAttribute(
			"data-theme",
			isDmSans ? "parchment" : "clean",
		);
	}, [preferences.fontFamily]);

	return (
		<AppPreferencesContext.Provider value={{ preferences, setFontFamily }}>
			{children}
		</AppPreferencesContext.Provider>
	);
};

export const useAppPreferences = () => {
	const context = useContext(AppPreferencesContext);
	if (!context) {
		throw new Error(
			"useAppPreferences must be used within AppPreferencesProvider",
		);
	}
	return context;
};
