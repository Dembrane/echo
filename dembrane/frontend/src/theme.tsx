import {
	Badge,
	type CSSVariablesResolver,
	createTheme,
	defaultVariantColorsResolver,
	Text,
	type VariantColorsResolver,
} from "@mantine/core";
import { CaretDownIcon, InfoIcon } from "@phosphor-icons/react";
import { mantineColors, roles, tagTints } from "./colors";
import buttonClasses from "./styles/button.module.css";

// The design system, October 2026: DM Sans at one weight (320), hierarchy
// from size and space, square corners except the primary pill, one 1px rule
// above and below anything bounded, AA contrast on every role. The rule and
// the molecule details live in styles/rules.css; type sizes live in
// --app-* variables set by useAppPreferences, so the user's font-size
// setting and the portal's smaller scale keep working.

// The Mantine colour names the app passes, mapped onto the roles.
const statusFor = (color?: string) => {
	switch (color) {
		case "red":
		case "salmon":
			return {
				onTint: roles.dangerOnTint,
				text: roles.danger,
				tint: roles.dangerTint,
			};
		case "yellow":
		case "orange":
		case "peach":
			return {
				onTint: roles.warning,
				text: roles.warning,
				tint: roles.warningTint,
			};
		case "green":
		case "teal":
		case "springGreen":
			return {
				onTint: roles.success,
				text: roles.success,
				tint: roles.successTint,
			};
		case "gray":
		case "graphite":
		case "parchment":
		case "dark":
			return { onTint: roles.text, text: roles.text, tint: tagTints.neutral };
		default:
			return {
				onTint: roles.action,
				text: roles.action,
				tint: roles.actionTint,
			};
	}
};

const tintFor = (color?: string) => {
	switch (color) {
		case "mauve":
			return tagTints.mauve;
		case "cyan":
			return tagTints.cyan;
		case "limeYellow":
			return tagTints.lime;
		default:
			return statusFor(color).tint;
	}
};

// Every variant resolves to a role: status text for anything that reads as
// text, a tint for anything that reads as a surface.
const variantColorResolver: VariantColorsResolver = (input) => {
	const { onTint, text, tint } = statusFor(input.color);
	const isNeutral = text === roles.text;
	switch (input.variant) {
		case "filled":
			return {
				background: isNeutral ? roles.text : text,
				border: "transparent",
				color: roles.surface,
				hover: roles.text,
				hoverColor: roles.surface,
			};
		case "light":
			return {
				background: tint,
				border: "transparent",
				color: onTint,
				hover: tint,
				hoverColor: onTint,
			};
		case "outline":
		case "default":
			return {
				background: "transparent",
				border: `1px solid ${isNeutral ? roles.text : text}`,
				color: text,
				hover: tint,
				hoverColor: text,
			};
		case "subtle":
		case "transparent":
			return {
				background: "transparent",
				border: "transparent",
				color: text,
				hover: tint,
				hoverColor: text,
			};
		default:
			return defaultVariantColorsResolver(input);
	}
};

export const cssVariablesResolver: CSSVariablesResolver = () => ({
	dark: {},
	light: {
		"--mantine-color-body": roles.bg,
		"--mantine-color-default-border": roles.text,
		"--mantine-color-dimmed": roles.muted,
		"--mantine-color-error": roles.danger,
		"--mantine-color-placeholder": roles.muted,
		"--mantine-color-text": roles.text,
	},
	variables: {
		"--mantine-color-black": roles.text,
		"--mantine-color-white": roles.surface,
	},
});

export const theme = createTheme({
	black: roles.text,
	breakpoints: {
		"2xl": "1536px",
		lg: "1024px",
		md: "768px",
		sm: "640px",
		xl: "1280px",
		xs: "320px",
	},
	colors: mantineColors,
	components: {
		// Swiss: the label leads at the left, the caret sits quietly at the right.
		Accordion: {
			defaultProps: {
				chevron: <CaretDownIcon size={16} />,
				chevronPosition: "right",
			},
		},
		ActionIcon: {
			defaultProps: { color: "gray", size: 36, variant: "subtle" },
		},
		Alert: {
			defaultProps: {
				icon: <InfoIcon size={20} />,
				radius: 0,
				variant: "light",
			},
			styles: { message: { color: roles.text } },
		},
		// Tags carry graphite on a tint; accent colours fail as text. The rule
		// above and below (and the full box when clickable) is in rules.css.
		Badge: Badge.extend({
			defaultProps: { radius: 0, variant: "light" },
			styles: { root: { textTransform: "none" } },
			vars: (_theme, props) => ({
				root: {
					"--badge-bd": "none",
					"--badge-bg": tintFor(props.color),
					"--badge-color": roles.text,
				},
			}),
		}),
		// Secondary is the default. Primary (the pill) has to be asked for.
		Button: {
			classNames: { root: buttonClasses.root },
			defaultProps: { color: "primary", variant: "outline" },
		},
		Card: { defaultProps: { radius: 0, withBorder: true } },
		Chip: { defaultProps: { radius: 0 } },
		Container: { defaultProps: { py: "lg" } },
		InputWrapper: {
			styles: { error: { color: roles.danger }, label: { marginBottom: 4 } },
		},
		Menu: { defaultProps: { shadow: "md" } },
		Paper: { defaultProps: { radius: 0, withBorder: true } },
		Select: {
			defaultProps: {
				comboboxProps: { shadow: "md" },
				rightSection: <CaretDownIcon size={16} />,
			},
			styles: { input: { backgroundColor: roles.bg, cursor: "pointer" } },
		},
		SimpleGrid: { defaultProps: { spacing: "sm" } },
		// Muted text differs by weight, not size: c="dimmed" gets the 240 cut.
		Text: Text.extend({
			classNames: (_theme, props) => ({
				root: props.c === "dimmed" ? "app-muted" : "",
			}),
		}),
		Textarea: { defaultProps: { resize: "vertical" } },
		Title: { defaultProps: { c: "var(--app-text)" } },
		Tooltip: { defaultProps: { arrowSize: 8, withArrow: true } },
	},
	defaultRadius: 0,
	focusRing: "auto",
	fontFamily: "var(--app-font-family, 'DM Sans Variable', sans-serif)",
	fontSizes: {
		lg: "var(--app-font-size-lg)",
		md: "var(--app-font-size-md)",
		sm: "var(--app-font-size-sm)",
		xl: "var(--app-font-size-xl)",
		xs: "var(--app-font-size-xs)",
	},
	// Swiss: every heading is a step up the ladder at the one weight, with space
	// above it (rules.css), never bold.
	headings: {
		fontFamily: "var(--app-font-family, 'DM Sans Variable', sans-serif)",
		fontWeight: "var(--app-heading-font-weight, 320)",
		sizes: {
			h1: {
				fontSize: "var(--app-heading-h1-size)",
				lineHeight: "var(--app-heading-h1-line-height)",
			},
			h2: {
				fontSize: "var(--app-heading-h2-size)",
				lineHeight: "var(--app-heading-h2-line-height)",
			},
			h3: {
				fontSize: "var(--app-heading-h3-size)",
				lineHeight: "var(--app-heading-h3-line-height)",
			},
			h4: {
				fontSize: "var(--app-heading-h4-size)",
				lineHeight: "var(--app-heading-h4-line-height)",
			},
			h5: {
				fontSize: "var(--app-heading-h5-size)",
				lineHeight: "var(--app-heading-h5-line-height)",
			},
			h6: {
				fontSize: "var(--app-heading-h6-size)",
				lineHeight: "var(--app-heading-h6-line-height)",
			},
		},
	},
	lineHeights: {
		lg: "var(--app-line-height-lg)",
		md: "var(--app-line-height-md)",
		sm: "var(--app-line-height-sm)",
		xl: "var(--app-line-height-xl)",
		xs: "var(--app-line-height-xs)",
	},
	primaryColor: "primary",
	// #2957df: 5.43:1 on parchment, 5.96:1 under white. Royal blue (shade 6)
	// fails AA as text and stays for large and decorative use.
	primaryShade: 7,
	// Square everywhere; only the primary action is a pill (button.module.css).
	radius: {
		"2xl": "0",
		"3xl": "0",
		DEFAULT: "0",
		full: "9999px",
		lg: "0",
		md: "0",
		none: "0",
		sm: "0",
		xl: "0",
		xs: "0",
	},
	shadows: {
		"2xl": "0 12px 40px rgb(45 45 44 / 0.12)",
		DEFAULT: "none",
		inner: "none",
		lg: "0 12px 40px rgb(45 45 44 / 0.12)",
		md: "0 12px 40px rgb(45 45 44 / 0.12)",
		none: "none",
		sm: "none",
		xl: "0 12px 40px rgb(45 45 44 / 0.12)",
		xs: "none",
	},
	// 4 / 8 / 16 / 24 / 32 for the named steps; the numeric Tailwind-style keys
	// stay for existing call sites.
	spacing: {
		0: "0",
		0.5: "0.125rem",
		1: "0.25rem",
		1.5: "0.375rem",
		2: "0.5rem",
		2.5: "0.625rem",
		"2xl": "2.5rem",
		3: "0.75rem",
		3.5: "0.875rem",
		4: "1rem",
		5: "1.25rem",
		6: "1.5rem",
		7: "1.75rem",
		8: "2rem",
		9: "2.25rem",
		10: "2.5rem",
		11: "2.75rem",
		12: "3rem",
		14: "3.5rem",
		16: "4rem",
		20: "5rem",
		24: "6rem",
		28: "7rem",
		32: "8rem",
		36: "9rem",
		40: "10rem",
		44: "11rem",
		48: "12rem",
		52: "13rem",
		56: "14rem",
		60: "15rem",
		64: "16rem",
		72: "18rem",
		80: "20rem",
		96: "24rem",
		lg: "1.5rem",
		md: "1rem",
		px: "1px",
		sm: "0.5rem",
		xl: "2rem",
		xs: "0.25rem",
	},
	variantColorResolver,
	white: roles.surface,
});
