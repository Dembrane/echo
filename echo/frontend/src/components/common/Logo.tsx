import { Group, type GroupProps, Loader } from "@mantine/core";
import aiconlLogo from "@/assets/aiconl-logo.png";
import aiconlLogoHQ from "@/assets/aiconl-logo-hq.png";

import dembraneLogoFull from "@/assets/dembrane-logo-new.svg";
import dembraneLogomark from "@/assets/logomark-no-bg.svg";
import { APP_ENVIRONMENT } from "@/config";
import { useWhitelabelLogo } from "@/hooks/useWhitelabelLogo";

type LogoProps = {
	hideLogo?: boolean;
	hideTitle?: boolean;
	alwaysDembrane?: boolean;
} & GroupProps;

export const LogoDembrane = ({
	hideLogo,
	hideTitle,
	alwaysDembrane,
	...props
}: LogoProps) => {
	const { logoUrl } = useWhitelabelLogo();
	const effectiveLogoUrl = alwaysDembrane ? null : logoUrl;
	// Show an env badge everywhere except production.
	const hostEnv = APP_ENVIRONMENT === "production" ? null : APP_ENVIRONMENT;

	return (
		<Group gap="sm" h="32px" align="center" {...props}>
			{!hideLogo && effectiveLogoUrl === undefined ? (
				<Loader size={24} color="gray" ml="xl" />
			) : !hideLogo ? (
				<span className="relative inline-flex h-full items-center">
					<img
						src={
							effectiveLogoUrl ??
							(hideTitle ? dembraneLogomark : dembraneLogoFull)
						}
						alt="Logo"
						className="h-full object-contain"
					/>
					{hostEnv && (
						<span
							className="pointer-events-none absolute capitalize -bottom-1 -right-[15px] -translate-x-1/2 pl-1 text-[10px] font-medium leading-none"
							style={{ color: "var(--mantine-color-primary-6)" }}
						>
							{hostEnv}
						</span>
					)}
				</span>
			) : null}
		</Group>
	);
};

const LogoAiCoNL = ({ hideLogo, hideTitle, ...props }: LogoProps) => (
	<Group gap="sm" h="30px" {...props}>
		{!hideLogo && (
			<img
				src={hideTitle ? aiconlLogo : aiconlLogoHQ}
				alt="AICONL Logo"
				className="h-full object-contain"
			/>
		)}
	</Group>
);

export const CURRENT_BRAND: "dembrane" | "aiconl" = "dembrane";

export const Logo = (props: LogoProps) => {
	return CURRENT_BRAND === "dembrane" ? (
		<LogoDembrane {...props} />
	) : (
		<LogoAiCoNL {...props} />
	);
};

export const DembraneLogomark = dembraneLogomark;
