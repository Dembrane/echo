import { t } from "@lingui/core/macro";
import {
	Group,
	type GroupProps,
	Loader,
	useComputedColorScheme,
} from "@mantine/core";
import aiconlLogo from "@/assets/aiconl-logo.png";
import aiconlLogoHQ from "@/assets/aiconl-logo-hq.png";
import dembraneLogoFull from "@/assets/dembrane-logo-new.svg";
import dembraneLogoFullDark from "@/assets/dembrane-logo-new-dark.svg";
import dembraneLogomark from "@/assets/logomark-no-bg.svg";
import dembraneLogomarkDark from "@/assets/logomark-no-bg-dark.svg";
import { roles } from "@/colors";
import { I18nLink } from "@/components/common/i18nLink";
import { APP_ENVIRONMENT, PREVIEW_PR } from "@/config";
import { useWhitelabelLogo } from "@/hooks/useWhitelabelLogo";

type LogoProps = {
	hideLogo?: boolean;
	hideTitle?: boolean;
	alwaysDembrane?: boolean;
	hideEnvBadge?: boolean;
	/**
	 * Makes the image a link. Pass it here rather than wrapping the logo in a
	 * link: on a PR preview the badge is its own link to the PR, and a link
	 * inside a link is invalid.
	 */
	to?: string;
	linkLabel?: string;
} & GroupProps;

const BADGE_CLASS =
	"absolute -bottom-1 -right-[15px] -translate-x-1/2 pl-1 leading-none whitespace-nowrap";
// The portal's root is smaller, so xs alone falls under the 14px floor there.
const BADGE_STYLE = {
	color: roles.action,
	fontSize: "max(var(--app-font-size-xs), 14px)",
};

/** The text under the logo: the PR on a PR preview, else the environment. */
const EnvBadge = () => {
	if (PREVIEW_PR) {
		const number = PREVIEW_PR.number;
		return (
			<a
				href={PREVIEW_PR.url}
				target="_blank"
				rel="noreferrer"
				className={`${BADGE_CLASS} hover:underline`}
				style={BADGE_STYLE}
				data-testid="logo-preview-pr"
			>
				{t`PR #${number}`}
			</a>
		);
	}
	// Show an env badge everywhere except production.
	if (APP_ENVIRONMENT === "production") return null;
	return (
		<span className={`pointer-events-none ${BADGE_CLASS}`} style={BADGE_STYLE}>
			{APP_ENVIRONMENT.charAt(0).toUpperCase() + APP_ENVIRONMENT.slice(1)}
		</span>
	);
};

export const LogoDembrane = ({
	hideLogo,
	hideTitle,
	alwaysDembrane,
	hideEnvBadge,
	to,
	linkLabel,
	...props
}: LogoProps) => {
	const { logoUrl } = useWhitelabelLogo();
	const effectiveLogoUrl = alwaysDembrane ? null : logoUrl;
	// The wordmark's graphite becomes parchment on a dark ground.
	const dark = useComputedColorScheme("light") === "dark";
	const ownLogo = hideTitle
		? dark
			? dembraneLogomarkDark
			: dembraneLogomark
		: dark
			? dembraneLogoFullDark
			: dembraneLogoFull;

	const image = (
		<img
			src={effectiveLogoUrl ?? ownLogo}
			alt="Logo"
			className="h-full object-contain"
		/>
	);

	return (
		<Group gap="sm" h="32px" align="center" {...props}>
			{!hideLogo && effectiveLogoUrl === undefined ? (
				<Loader size={24} color="gray" ml="xl" />
			) : !hideLogo ? (
				<span className="relative inline-flex h-full items-center">
					{to ? (
						<I18nLink
							to={to}
							aria-label={linkLabel}
							className="inline-flex h-full items-center transition-opacity hover:opacity-80"
						>
							{image}
						</I18nLink>
					) : (
						image
					)}
					{!hideEnvBadge && <EnvBadge />}
				</span>
			) : null}
		</Group>
	);
};

const LogoAiCoNL = ({
	hideLogo,
	hideTitle,
	alwaysDembrane: _alwaysDembrane,
	hideEnvBadge: _hideEnvBadge,
	to,
	linkLabel,
	...props
}: LogoProps) => {
	const image = (
		<img
			src={hideTitle ? aiconlLogo : aiconlLogoHQ}
			alt="AICONL Logo"
			className="h-full object-contain"
		/>
	);
	return (
		<Group gap="sm" h="30px" {...props}>
			{!hideLogo &&
				(to ? (
					<I18nLink to={to} aria-label={linkLabel} className="h-full">
						{image}
					</I18nLink>
				) : (
					image
				))}
		</Group>
	);
};

export const CURRENT_BRAND: "dembrane" | "aiconl" = "dembrane";

export const Logo = (props: LogoProps) => {
	return CURRENT_BRAND === "dembrane" ? (
		<LogoDembrane {...props} />
	) : (
		<LogoAiCoNL {...props} />
	);
};

export const DembraneLogomark = dembraneLogomark;
