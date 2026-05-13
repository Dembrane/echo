import { Group, type GroupProps, Loader } from "@mantine/core";
import aiconlLogo from "@/assets/aiconl-logo.png";
import aiconlLogoHQ from "@/assets/aiconl-logo-hq.png";

import dembraneLogoFull from "@/assets/dembrane-logo-new.svg";
import dembraneLogomark from "@/assets/logomark-no-bg.svg";
import { useWhitelabelLogo } from "@/hooks/useWhitelabelLogo";

type LogoProps = {
	hideLogo?: boolean;
	hideTitle?: boolean;
	alwaysDembrane?: boolean;
} & GroupProps;

export const LogoDembrane = ({ hideLogo, hideTitle, alwaysDembrane, ...props }: LogoProps) => {
	const { logoUrl } = useWhitelabelLogo();
	const effectiveLogoUrl = alwaysDembrane ? null : logoUrl;

	return (
		<Group gap="sm" h="36px" align="center" {...props}>
			{!hideLogo && effectiveLogoUrl === undefined ? (
				<Loader size={24} color="gray" ml="xl" />
			) : !hideLogo ? (
				<img
					src={effectiveLogoUrl ?? (hideTitle ? dembraneLogomark : dembraneLogoFull)}
					alt="Logo"
					className="h-full object-contain"
				/>
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
