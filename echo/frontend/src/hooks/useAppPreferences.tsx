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
		const root = document.documentElement;

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

		const baseFontSize = isDmSans ? "18px" : "16px";

		// Space Grotesk: Original Mantine-based sizes with medium weight
		const typography = isDmSans
			? {
					fontSizeLg: "1.125rem",
					fontSizeMd: "1rem",
					fontSizeSm: "0.875rem",
					fontSizeXl: "1.333rem",
					// Font sizes
					fontSizeXs: "0.75rem",
					h1LineHeight: "1.2",
					// Heading sizes
					h1Size: "2.778rem",
					h2LineHeight: "1.25",
					h2Size: "2.369rem",
					h3LineHeight: "1.3",
					h3Size: "1.777rem",
					h4LineHeight: "1.4",
					h4Size: "1.333rem",
					h5LineHeight: "1.5",
					h5Size: "1rem",
					h6LineHeight: "1.5",
					h6Size: "0.875rem",
					// Heading font weight
					headingFontWeight: "300",
					lineHeightLg: "1.6",
					lineHeightMd: "1.55",
					lineHeightSm: "1.45",
					lineHeightXl: "1.65",
					// Line heights
					lineHeightXs: "1.4",
				}
			: {
					fontSizeLg: "1.125rem",
					fontSizeMd: "1rem",
					fontSizeSm: "0.875rem",
					fontSizeXl: "1.25rem",
					// Font sizes (original Mantine defaults)
					fontSizeXs: "0.75rem",
					h1LineHeight: "1.3",
					// Heading sizes (original Mantine defaults with --mantine-scale)
					h1Size: "2.125rem",
					h2LineHeight: "1.35",
					h2Size: "1.875rem",
					h3LineHeight: "1.4",
					h3Size: "1.5rem",
					h4LineHeight: "1.45",
					h4Size: "1.25rem",
					h5LineHeight: "1.5",
					h5Size: "1rem",
					h6LineHeight: "1.5",
					h6Size: "0.875rem",
					// Heading font weight
					headingFontWeight: "500",
					lineHeightLg: "1.6",
					lineHeightMd: "1.55",
					lineHeightSm: "1.45",
					lineHeightXl: "1.65",
					// Line heights
					lineHeightXs: "1.4",
				};

		// Icon sizes: DM Sans uses larger icons to match the bolder typography
		const homeIconSize = isDmSans ? "40px" : "30px";

		// Set base font size
		root.style.setProperty("--app-base-font-size", baseFontSize);

		// Set font family
		root.style.setProperty("--app-font-family", fontValue);

		// Set colors
		root.style.setProperty("--app-background", backgroundColor);
		root.style.setProperty("--app-text", textColor);

		// Set icon sizes
		root.style.setProperty("--app-home-icon-size", homeIconSize);

		// Set typography - font sizes
		root.style.setProperty("--app-font-size-xs", typography.fontSizeXs);
		root.style.setProperty("--app-font-size-sm", typography.fontSizeSm);
		root.style.setProperty("--app-font-size-md", typography.fontSizeMd);
		root.style.setProperty("--app-font-size-lg", typography.fontSizeLg);
		root.style.setProperty("--app-font-size-xl", typography.fontSizeXl);

		// Set typography - line heights
		root.style.setProperty("--app-line-height-xs", typography.lineHeightXs);
		root.style.setProperty("--app-line-height-sm", typography.lineHeightSm);
		root.style.setProperty("--app-line-height-md", typography.lineHeightMd);
		root.style.setProperty("--app-line-height-lg", typography.lineHeightLg);
		root.style.setProperty("--app-line-height-xl", typography.lineHeightXl);

		// Set typography - heading sizes
		root.style.setProperty(
			"--app-heading-font-weight",
			typography.headingFontWeight,
		);
		root.style.setProperty("--app-heading-h1-size", typography.h1Size);
		root.style.setProperty(
			"--app-heading-h1-line-height",
			typography.h1LineHeight,
		);
		root.style.setProperty("--app-heading-h2-size", typography.h2Size);
		root.style.setProperty(
			"--app-heading-h2-line-height",
			typography.h2LineHeight,
		);
		root.style.setProperty("--app-heading-h3-size", typography.h3Size);
		root.style.setProperty(
			"--app-heading-h3-line-height",
			typography.h3LineHeight,
		);
		root.style.setProperty("--app-heading-h4-size", typography.h4Size);
		root.style.setProperty(
			"--app-heading-h4-line-height",
			typography.h4LineHeight,
		);
		root.style.setProperty("--app-heading-h5-size", typography.h5Size);
		root.style.setProperty(
			"--app-heading-h5-line-height",
			typography.h5LineHeight,
		);
		root.style.setProperty("--app-heading-h6-size", typography.h6Size);
		root.style.setProperty(
			"--app-heading-h6-line-height",
			typography.h6LineHeight,
		);

		// Override Mantine's CSS variables so components using them update dynamically
		root.style.setProperty("--mantine-color-white", backgroundColor);
		root.style.setProperty("--mantine-color-black", textColor);
		root.style.setProperty("--mantine-color-text", textColor);
		root.style.setProperty("--mantine-color-body", backgroundColor);

		// Apply to body
		document.body.style.fontFamily = fontValue;
		document.body.style.backgroundColor = backgroundColor;
		document.body.style.color = textColor;
		document.body.style.fontFeatureSettings = fontFeatureSettings;

		// Set CSS variable for font feature settings
		root.style.setProperty("--app-font-feature-settings", fontFeatureSettings);

		// Set data attribute for potential CSS selectors
		root.setAttribute("data-theme", isDmSans ? "parchment" : "clean");
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
