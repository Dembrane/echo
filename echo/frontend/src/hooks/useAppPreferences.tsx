import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useState,
} from "react";

import { USE_PARTICIPANT_ROUTER } from "../config";

// The portal (participant) app shares the dashboard type scale, which was
// recently bumped up everywhere. At participant reading distances that ramp
// reads a touch large, so the portal renders one notch smaller. This only
// scales the size-bearing vars (font + heading sizes); line heights and
// weights are ratios and stay as-is.
const PORTAL_FONT_SCALE = USE_PARTICIPANT_ROUTER ? 0.9 : 1;

const scaleTypeSize = (value: string): string => {
	if (PORTAL_FONT_SCALE === 1) return value;
	const match = value.match(/^([\d.]+)(rem|px)$/);
	if (!match) return value;
	const scaled = Number.parseFloat(match[1]) * PORTAL_FONT_SCALE;
	return `${Number.parseFloat(scaled.toFixed(4))}${match[2]}`;
};

export type FontFamily = "dm-sans" | "space-grotesk";
export type FontSizeScale = "xs" | "small" | "normal" | "large" | "xl";

type AppPreferences = {
	fontFamily: FontFamily;
	fontSizeScale: FontSizeScale;
};

type AppPreferencesContextType = {
	preferences: AppPreferences;
	setFontFamily: (font: FontFamily) => void;
	setFontSizeScale: (scale: FontSizeScale) => void;
};

const defaultPreferences: AppPreferences = {
	fontFamily: "dm-sans",
	fontSizeScale: "normal",
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

	const setFontSizeScale = (scale: FontSizeScale) => {
		setPreferences((prev) => {
			const updated = { ...prev, fontSizeScale: scale };
			savePreferences(updated);
			return updated;
		});
	};

	// Apply font and linked color scheme to document
	useEffect(() => {
		const isDmSans = preferences.fontFamily === "dm-sans";
		const scale = preferences.fontSizeScale || "normal";
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

		// Base font size depends on both font family and scale
		const fontSizeMap = isDmSans
			? { large: "18px", normal: "16px", small: "14px", xl: "20px", xs: "12px" }
			: {
					large: "18px",
					normal: "16px",
					small: "14px",
					xl: "20px",
					xs: "12px",
				};
		const baseFontSize = fontSizeMap[scale];

		// Space Grotesk: Original Mantine-based sizes with medium weight
		const typography = isDmSans
			? {
					fontSizeLg: "1.5rem", // Heading3: 24px (larger body)
					fontSizeMd: "1.25rem", // Body1: 20px (standard body, default)
					fontSizeSm: "0.9375rem", // Body2: 15px (low-emphasis secondary)
					fontSizeXl: "1.75rem", // Heading2: 28px
					// Distinct type ramp: Body3 12 / Body2 15 / Body1 20 (default body)
					// / Heading3 24 / Heading2 28. Steps are kept far enough apart to
					// avoid the 2px "uncanny valley" gaps the old scale had.
					fontSizeXs: "0.75rem", // Body3: 12px (captions, gentle labels)
					h1LineHeight: "1.15",
					// Heading sizes: Title 36 / H1 32 / H2 28 / H3 24, then graceful
					// descent to body sizes for h5/h6.
					h1Size: "2.25rem", // Title: 36px
					h2LineHeight: "1.2",
					h2Size: "2rem", // Heading1: 32px
					h3LineHeight: "1.25",
					h3Size: "1.75rem", // Heading2: 28px
					h4LineHeight: "1.3",
					h4Size: "1.5rem", // Heading3: 24px
					h5LineHeight: "1.4",
					h5Size: "1.25rem", // Body1: 20px
					h6LineHeight: "1.45",
					h6Size: "0.9375rem", // Body2: 15px
					// Heading font weight: Regular per brand STYLE_GUIDE.md
					headingFontWeight: "400",
					lineHeightLg: "1.5",
					lineHeightMd: "1.55",
					lineHeightSm: "1.45",
					lineHeightXl: "1.4",
					// Line heights
					lineHeightXs: "1.4",
				}
			: {
					fontSizeLg: "1.5rem", // Heading3: 24px
					fontSizeMd: "1.25rem", // Body1: 20px (default body)
					fontSizeSm: "0.9375rem", // Body2: 15px
					fontSizeXl: "1.75rem", // Heading2: 28px
					// Same distinct type ramp as the DM Sans palette; only the heading
					// weight differs (Space Grotesk reads better at medium weight).
					fontSizeXs: "0.75rem", // Body3: 12px
					h1LineHeight: "1.15",
					h1Size: "2.25rem", // Title: 36px
					h2LineHeight: "1.2",
					h2Size: "2rem", // Heading1: 32px
					h3LineHeight: "1.25",
					h3Size: "1.75rem", // Heading2: 28px
					h4LineHeight: "1.3",
					h4Size: "1.5rem", // Heading3: 24px
					h5LineHeight: "1.4",
					h5Size: "1.25rem", // Body1: 20px
					h6LineHeight: "1.45",
					h6Size: "0.9375rem", // Body2: 15px
					// Heading font weight
					headingFontWeight: "500",
					lineHeightLg: "1.5",
					lineHeightMd: "1.55",
					lineHeightSm: "1.45",
					lineHeightXl: "1.4",
					// Line heights
					lineHeightXs: "1.4",
				};

		// Icon sizes: DM Sans uses larger icons to match the bolder typography
		const homeIconSize = typography?.h2Size ?? "2.369rem";

		// Set base font size
		root.style.setProperty("--app-base-font-size", scaleTypeSize(baseFontSize));

		// Set font family
		root.style.setProperty("--app-font-family", fontValue);

		// Set colors
		root.style.setProperty("--app-background", backgroundColor);
		root.style.setProperty("--app-text", textColor);

		// Set icon sizes
		root.style.setProperty("--app-home-icon-size", scaleTypeSize(homeIconSize));

		// Set typography - font sizes
		root.style.setProperty(
			"--app-font-size-xs",
			scaleTypeSize(typography.fontSizeXs),
		);
		root.style.setProperty(
			"--app-font-size-sm",
			scaleTypeSize(typography.fontSizeSm),
		);
		root.style.setProperty(
			"--app-font-size-md",
			scaleTypeSize(typography.fontSizeMd),
		);
		root.style.setProperty(
			"--app-font-size-lg",
			scaleTypeSize(typography.fontSizeLg),
		);
		root.style.setProperty(
			"--app-font-size-xl",
			scaleTypeSize(typography.fontSizeXl),
		);

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
		root.style.setProperty(
			"--app-heading-h1-size",
			scaleTypeSize(typography.h1Size),
		);
		root.style.setProperty(
			"--app-heading-h1-line-height",
			typography.h1LineHeight,
		);
		root.style.setProperty(
			"--app-heading-h2-size",
			scaleTypeSize(typography.h2Size),
		);
		root.style.setProperty(
			"--app-heading-h2-line-height",
			typography.h2LineHeight,
		);
		root.style.setProperty(
			"--app-heading-h3-size",
			scaleTypeSize(typography.h3Size),
		);
		root.style.setProperty(
			"--app-heading-h3-line-height",
			typography.h3LineHeight,
		);
		root.style.setProperty(
			"--app-heading-h4-size",
			scaleTypeSize(typography.h4Size),
		);
		root.style.setProperty(
			"--app-heading-h4-line-height",
			typography.h4LineHeight,
		);
		root.style.setProperty(
			"--app-heading-h5-size",
			scaleTypeSize(typography.h5Size),
		);
		root.style.setProperty(
			"--app-heading-h5-line-height",
			typography.h5LineHeight,
		);
		root.style.setProperty(
			"--app-heading-h6-size",
			scaleTypeSize(typography.h6Size),
		);
		root.style.setProperty(
			"--app-heading-h6-line-height",
			typography.h6LineHeight,
		);

		// Override Mantine's CSS variables so components using them update dynamically
		root.style.setProperty("--mantine-color-white", backgroundColor);
		root.style.setProperty("--mantine-color-black", textColor);
		root.style.setProperty("--mantine-color-text", textColor);
		root.style.setProperty("--mantine-color-body", backgroundColor);

		// Style rule: never the off-brand Mantine "dimmed" gray, and never on
		// primary text. We keep a single subtle secondary tone (a softened
		// version of the real text color) so hierarchy survives without the
		// washed-out gray. Pair it with a smaller size (Body2/Body3) for
		// secondary copy; use full --app-text for anything primary.
		root.style.setProperty(
			"--mantine-color-dimmed",
			"color-mix(in srgb, var(--app-text) 70%, transparent)",
		);

		// Apply to body
		document.body.style.fontFamily = fontValue;
		document.body.style.backgroundColor = backgroundColor;
		document.body.style.color = textColor;
		document.body.style.fontFeatureSettings = fontFeatureSettings;

		// Set CSS variable for font feature settings
		root.style.setProperty("--app-font-feature-settings", fontFeatureSettings);

		// Set data attribute for potential CSS selectors
		root.setAttribute("data-theme", isDmSans ? "parchment" : "clean");
	}, [preferences.fontFamily, preferences.fontSizeScale]);

	return (
		<AppPreferencesContext.Provider
			value={{ preferences, setFontFamily, setFontSizeScale }}
		>
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
