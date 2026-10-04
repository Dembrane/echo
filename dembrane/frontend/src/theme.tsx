import { t } from "@lingui/core/macro";
import {
	Badge,
	Button,
	type CSSVariablesResolver,
	createTheme,
	defaultVariantColorsResolver,
	Input,
	Text,
	type VariantColorsResolver,
} from "@mantine/core";
import { CaretDownIcon, InfoIcon } from "@phosphor-icons/react";
import {
	darkRoles,
	darkRoleVars,
	lightRoles,
	lightRoleVars,
	mantineColors,
	roles,
	tagTints,
} from "./colors";
import buttonClasses from "./styles/button.module.css";

// The design system, October 2026: DM Sans at one weight (320), hierarchy
// from size and space, square corners except the primary pill, one 1px rule
// above and below anything bounded, AA contrast on every role. The rule and
// the molecule details live in styles/rules.css; type sizes live in
// --app-* variables set by useAppPreferences, so the user's font-size
// setting and the portal's smaller scale keep working.

// A control's size changes its height, never its text: Mantine reads field
// and button text off the type ladder (size lg would be 24.88). Text is 16,
// 14 in compact controls; the height steps 30 / 36 / 40 / 48.
const CONTROL_HEIGHT: Record<string, string> = {
	lg: "48px",
	md: "40px",
	sm: "36px",
	xl: "48px",
	xs: "30px",
};
const BADGE_HEIGHT: Record<string, string> = {
	lg: "28px",
	md: "24px",
	sm: "22px",
	xl: "32px",
	xs: "22px",
};
const controlText = (size?: string) =>
	size === "xs" || size?.startsWith("compact")
		? "var(--app-font-size-xs)"
		: "var(--app-font-size-sm)";

// The Mantine colour names the app passes, mapped onto the roles.
const statusFor = (color?: string) => {
	// "red.2" or "blue.1" mean the family; the role decides the shade.
	switch (color?.split(".")[0]) {
		case "red":
		case "salmon":
			return {
				fill: roles.dangerFill,
				onTint: roles.dangerOnTint,
				text: roles.danger,
				tint: roles.dangerTint,
			};
		case "yellow":
		case "orange":
		case "peach":
			return {
				fill: roles.warningFill,
				onTint: roles.warning,
				text: roles.warning,
				tint: roles.warningTint,
			};
		case "green":
		case "teal":
		case "springGreen":
			return {
				fill: roles.successFill,
				onTint: roles.success,
				text: roles.success,
				tint: roles.successTint,
			};
		case "gray":
		case "graphite":
		case "parchment":
		case "dark":
			return {
				fill: roles.fillHover,
				onTint: roles.text,
				text: roles.text,
				tint: tagTints.neutral,
			};
		default:
			return {
				fill: roles.actionFill,
				onTint: roles.action,
				text: roles.action,
				tint: roles.actionTint,
			};
	}
};

const tintFor = (color?: string) => {
	switch (color?.split(".")[0]) {
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
// text, a tint for anything that reads as a surface. On a tint (light, and
// outline or subtle on hover) the text takes the on-tint colour: danger
// #c0434e is 3.9:1 on its tint, #a8323c passes.
const variantColorResolver: VariantColorsResolver = (input) => {
	const { fill, onTint, text, tint } = statusFor(input.color);
	const isNeutral = text === roles.text;
	switch (input.variant) {
		// A fill keeps its colour in dark; every fill hovers to graphite, which
		// in dark inverts to parchment under black text.
		case "filled":
			return {
				background: fill,
				border: "transparent",
				color: isNeutral ? roles.onFillHover : roles.onFill,
				hover: roles.fillHover,
				hoverColor: roles.onFillHover,
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
				hoverColor: onTint,
			};
		case "subtle":
		case "transparent":
			return {
				background: "transparent",
				border: "transparent",
				color: text,
				hover: tint,
				hoverColor: onTint,
			};
		default:
			return defaultVariantColorsResolver(input);
	}
};

// Every --app-* colour is set here per scheme, from the hexes in colors.ts;
// rules.css and the components read the variables. Mantine's white is the
// surface (white in light, the raised surface in dark): controls and
// surfaces are white whatever the page ground is.
const mantineRoles = (scheme: typeof lightRoles | typeof darkRoles) => ({
	"--mantine-color-black": scheme.text,
	// c="dark" and c="graphite" mean the text colour; Mantine would draw
	// shade 4 in dark (graphite is #2d2d2c at every shade).
	"--mantine-color-dark-text": roles.text,
	"--mantine-color-graphite-text": roles.text,
	"--mantine-color-body": roles.bg,
	"--mantine-color-default-border": roles.quiet,
	"--mantine-color-dimmed": roles.muted,
	"--mantine-color-error": roles.danger,
	"--mantine-color-placeholder": roles.muted,
	"--mantine-color-text": roles.text,
	"--mantine-color-white": scheme.surface,
});

export const cssVariablesResolver: CSSVariablesResolver = () => ({
	dark: {
		...darkRoleVars,
		...mantineRoles(darkRoles),
		// A floating layer's shadow; light keeps rules.css's graphite one.
		"--app-float": "0 12px 40px rgb(0 0 0 / 0.8)",
		// Mantine's "bright" is white in dark; ours is the page ground.
		"--mantine-color-bright": roles.text,
		"--mantine-primary-color-contrast": roles.onFill,
	},
	light: { ...lightRoleVars, ...mantineRoles(lightRoles) },
	variables: {},
});

export const theme = createTheme({
	black: lightRoles.text,
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
			// No text below the ladder's floor: a tag reads at 14 whatever its
			// size (Mantine's xs badge is 9px); size sets the height.
			vars: (_theme, props) => ({
				root: {
					"--badge-bd": "none",
					"--badge-bg": tintFor(props.color),
					"--badge-color": roles.text,
					"--badge-fz": "var(--app-font-size-xs)",
					"--badge-height":
						BADGE_HEIGHT[typeof props.size === "string" ? props.size : "md"] ??
						"24px",
					"--badge-padding-x": "8px",
				},
			}),
		}),
		// Secondary is the default. Primary (the pill) has to be asked for.
		Button: Button.extend({
			classNames: { root: buttonClasses.root },
			defaultProps: { color: "primary", variant: "outline" },
			vars: (_theme, props) => {
				const size = typeof props.size === "string" ? props.size : "sm";
				return {
					root: {
						"--button-fz": controlText(size),
						...(CONTROL_HEIGHT[size] && {
							"--button-height": CONTROL_HEIGHT[size],
						}),
					},
				};
			},
		}),
		Card: { defaultProps: { radius: 0, withBorder: true } },
		Chip: { defaultProps: { radius: 0 } },
		Container: { defaultProps: { py: "lg" } },
		Input: Input.extend({
			vars: (_theme, props) => {
				const size = typeof props.size === "string" ? props.size : "sm";
				return {
					wrapper: {
						"--input-fz": controlText(size),
						...(CONTROL_HEIGHT[size] && {
							"--input-height": CONTROL_HEIGHT[size],
						}),
					},
				};
			},
		}),
		InputWrapper: {
			styles: { error: { color: roles.danger }, label: { marginBottom: 4 } },
		},
		// Loading covers the page in its own parchment, not a white flash.
		LoadingOverlay: {
			defaultProps: {
				loaderProps: { size: "sm" },
				overlayProps: { backgroundOpacity: 0.85, blur: 0, color: roles.bg },
			},
		},
		Menu: { defaultProps: { shadow: "md" } },
		// Icon-only controls get a name. Getters, so the label is read when the
		// control renders, in the language active then (the theme is built once).
		Modal: {
			defaultProps: {
				closeButtonProps: {
					get "aria-label"() {
						return t`Close`;
					},
				},
			},
		},
		Pagination: {
			defaultProps: {
				getControlProps: (
					control: "first" | "previous" | "last" | "next",
				) => ({
					"aria-label": {
						first: t`First page`,
						last: t`Last page`,
						next: t`Next page`,
						previous: t`Previous page`,
					}[control],
				}),
			},
		},
		Paper: { defaultProps: { radius: 0, withBorder: true } },
		Select: {
			defaultProps: {
				comboboxProps: { shadow: "md" },
				rightSection: <CaretDownIcon size={16} />,
			},
			styles: { input: { cursor: "pointer" } },
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
		// The stem (rules.css) is as long as the offset, so it reaches the target.
		Tooltip: { defaultProps: { arrowSize: 8, offset: 8, withArrow: true } },
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
		"2xl": "var(--app-float)",
		DEFAULT: "none",
		inner: "none",
		lg: "var(--app-float)",
		md: "var(--app-float)",
		none: "none",
		sm: "none",
		xl: "var(--app-float)",
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
	white: lightRoles.surface,
});
