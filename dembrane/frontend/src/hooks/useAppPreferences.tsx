import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useState,
} from "react";

import { USE_PARTICIPANT_ROUTER } from "../config";

// The portal (participant) app shares the dashboard type scale. At
// participant reading distances it reads a touch large, so the portal renders
// one notch smaller. This only scales the size-bearing vars (font + heading
// sizes); line heights and weights are ratios and stay as-is.
const PORTAL_FONT_SCALE = USE_PARTICIPANT_ROUTER ? 0.9 : 1;

const scaleTypeSize = (value: string): string => {
	if (PORTAL_FONT_SCALE === 1) return value;
	const match = value.match(/^([\d.]+)(rem|px)$/);
	if (!match) return value;
	const scaled = Number.parseFloat(match[1]) * PORTAL_FONT_SCALE;
	return `${Number.parseFloat(scaled.toFixed(4))}${match[2]}`;
};

// One font since October 2026 (the Space Grotesk theme is retired). The type
// is kept so stored preferences and old ?theme= links still parse.
export type FontFamily = "dm-sans";
export type FontSizeScale = "xs" | "small" | "normal" | "large" | "xl";

type AppPreferences = {
	fontFamily: FontFamily;
	fontSizeScale: FontSizeScale;
};

type AppPreferencesContextType = {
	preferences: AppPreferences;
	setFontSizeScale: (scale: FontSizeScale) => void;
};

const defaultPreferences: AppPreferences = {
	fontFamily: "dm-sans",
	fontSizeScale: "normal",
};

const STORAGE_KEY = "dembrane-app-preferences-v2";

const FONT_SIZE_SCALES: FontSizeScale[] = [
	"xs",
	"small",
	"normal",
	"large",
	"xl",
];

const AppPreferencesContext = createContext<AppPreferencesContextType | null>(
	null,
);

const loadPreferences = (): AppPreferences => {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored) {
			const parsed = JSON.parse(stored);
			// Only the size scale survives; a stored Space Grotesk choice is ignored.
			if (FONT_SIZE_SCALES.includes(parsed?.fontSizeScale)) {
				return { ...defaultPreferences, fontSizeScale: parsed.fontSizeScale };
			}
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

// The base size behind every rem: the user's font-size setting.
const BASE_FONT_SIZE: Record<FontSizeScale, string> = {
	large: "18px",
	normal: "16px",
	small: "14px",
	xl: "20px",
	xs: "12px",
};

// dembrane.com's perfect-fourth ladder from 14px, in rem of a 16px base:
// 14 / 16 / 18.66 / 24.88 / 33.17 / 44.2. Headings are full steps at the one
// weight (320); hierarchy comes from size and space, not bold.
const TYPOGRAPHY = {
	fontSizeLg: "1.555rem", // 24.88
	fontSizeMd: "1.16625rem", // 18.66, reading text (Text default)
	fontSizeSm: "1rem", // 16, UI text
	fontSizeXl: "2.0731rem", // 33.17
	fontSizeXs: "0.875rem", // 14, meta; nothing smaller
	h1LineHeight: "1.1",
	h1Size: "2.7625rem", // 44.2
	h2LineHeight: "1.15",
	h2Size: "2.0731rem", // 33.17
	h3LineHeight: "1.25",
	h3Size: "1.555rem", // 24.88
	h4LineHeight: "1.25",
	h4Size: "1.555rem", // 24.88
	h5LineHeight: "1.4",
	h5Size: "1.16625rem", // 18.66
	h6LineHeight: "1.45",
	h6Size: "1rem", // 16
	headingFontWeight: "320",
	lineHeightLg: "1.3",
	lineHeightMd: "1.55",
	lineHeightSm: "1.5",
	lineHeightXl: "1.2",
	lineHeightXs: "1.45",
};

const FONT_FAMILY = "'DM Sans Variable', sans-serif";
const FONT_FEATURE_SETTINGS =
	"'ss01' on, 'ss02' on, 'ss03' on, 'ss04' on, 'ss05' on, 'ss06' on, 'ss08' on";
const BACKGROUND = "#F6F4F1";
const TEXT = "#2D2D2C";
// Cool slate: AA on parchment (5.41), white (5.93) and the hover grey (4.64).
const MUTED = "#5f646f";

export const AppPreferencesProvider = ({
	children,
}: {
	children: ReactNode;
}) => {
	const [preferences, setPreferences] =
		useState<AppPreferences>(loadPreferences);

	const setFontSizeScale = (scale: FontSizeScale) => {
		setPreferences((prev) => {
			const updated = { ...prev, fontSizeScale: scale };
			savePreferences(updated);
			return updated;
		});
	};

	useEffect(() => {
		const scale = preferences.fontSizeScale || "normal";
		const root = document.documentElement;
		const t = TYPOGRAPHY;
		const set = (name: string, value: string) =>
			root.style.setProperty(name, value);

		set("--app-base-font-size", scaleTypeSize(BASE_FONT_SIZE[scale]));
		set("--app-font-family", FONT_FAMILY);
		set("--app-content-bold-font-family", FONT_FAMILY);
		set("--app-background", BACKGROUND);
		set("--app-text", TEXT);
		set("--app-home-icon-size", scaleTypeSize(t.h2Size));

		set("--app-font-size-xs", scaleTypeSize(t.fontSizeXs));
		set("--app-font-size-sm", scaleTypeSize(t.fontSizeSm));
		set("--app-font-size-md", scaleTypeSize(t.fontSizeMd));
		set("--app-font-size-lg", scaleTypeSize(t.fontSizeLg));
		set("--app-font-size-xl", scaleTypeSize(t.fontSizeXl));

		set("--app-line-height-xs", t.lineHeightXs);
		set("--app-line-height-sm", t.lineHeightSm);
		set("--app-line-height-md", t.lineHeightMd);
		set("--app-line-height-lg", t.lineHeightLg);
		set("--app-line-height-xl", t.lineHeightXl);

		set("--app-heading-font-weight", t.headingFontWeight);
		set("--app-heading-h1-size", scaleTypeSize(t.h1Size));
		set("--app-heading-h1-line-height", t.h1LineHeight);
		set("--app-heading-h2-size", scaleTypeSize(t.h2Size));
		set("--app-heading-h2-line-height", t.h2LineHeight);
		set("--app-heading-h3-size", scaleTypeSize(t.h3Size));
		set("--app-heading-h3-line-height", t.h3LineHeight);
		set("--app-heading-h4-size", scaleTypeSize(t.h4Size));
		set("--app-heading-h4-line-height", t.h4LineHeight);
		set("--app-heading-h5-size", scaleTypeSize(t.h5Size));
		set("--app-heading-h5-line-height", t.h5LineHeight);
		set("--app-heading-h6-size", scaleTypeSize(t.h6Size));
		set("--app-heading-h6-line-height", t.h6LineHeight);

		// Body is parchment, surfaces (fields, menus, dialogs) are white; the
		// theme's cssVariablesResolver sets both. Muted is a solid AA colour.
		set("--mantine-color-text", TEXT);
		set("--mantine-color-body", BACKGROUND);
		set("--mantine-color-dimmed", MUTED);

		document.body.style.fontFamily = FONT_FAMILY;
		document.body.style.backgroundColor = BACKGROUND;
		document.body.style.color = TEXT;
		document.body.style.fontFeatureSettings = FONT_FEATURE_SETTINGS;
		set("--app-font-feature-settings", FONT_FEATURE_SETTINGS);

		root.setAttribute("data-theme", "parchment");
	}, [preferences.fontSizeScale]);

	return (
		<AppPreferencesContext.Provider value={{ preferences, setFontSizeScale }}>
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
