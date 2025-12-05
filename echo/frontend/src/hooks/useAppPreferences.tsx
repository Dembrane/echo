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
	fontFamily: "space-grotesk",
};

const STORAGE_KEY = "dembrane-app-preferences";

const AppPreferencesContext = createContext<AppPreferencesContextType | null>(
	null,
);

const loadPreferences = (): AppPreferences => {
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
