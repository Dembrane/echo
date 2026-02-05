import { Group, type GroupProps } from "@mantine/core";
import aiconlLogo from "@/assets/aiconl-logo.png";
import aiconlLogoHQ from "@/assets/aiconl-logo-hq.png";

import dembraneLogoFull from "@/assets/dembrane-logo-new.svg";
import dembraneLogomark from "@/assets/logomark-no-bg.svg";

type LogoProps = {
	hideLogo?: boolean;
	hideTitle?: boolean;
} & GroupProps;

export const LogoDembrane = ({ hideLogo, hideTitle, ...props }: LogoProps) => (
	<Group gap="sm" h="36px" align="center" {...props}>
		{!hideLogo && (
			<img
				src={hideTitle ? dembraneLogomark : dembraneLogoFull}
				alt="Dembrane Logo"
				className="h-full object-contain"
			/>
		)}
	</Group>
);

const LogoAiCoNL = ({ hideLogo, hideTitle, ...props }: LogoProps) => (
	<Group gap="sm" h="30px" {...props}>
		{!hideLogo && (
			<img
				src={hideTitle ? aiconlLogo : aiconlLogoHQ}
				alt="AICONL Logo"
				className="h-full object-contain"
			/>
		)}
		{/* {!hideTitle && (
      <Title order={1} className="text-xl">
        AICONL
      </Title>
    )} */}
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

// Export logomark for use in spinners and loading indicators
export const DembraneLogomark = dembraneLogomark;
