import { Group, type GroupProps } from "@mantine/core";
import aiconlLogo from "@/assets/aiconl-logo.png";
import aiconlLogoHQ from "@/assets/aiconl-logo-hq.png";

import logomark from "@/assets/logomark-no-bg.svg";
import wordmark from "@/assets/wordmark-no-padding.svg";

type LogoProps = {
	hideLogo?: boolean;
	hideTitle?: boolean;
	textAfterLogo?: string | React.ReactNode;
} & GroupProps;

export const LogoDembrane = ({
	hideLogo,
	hideTitle,
	textAfterLogo,
	...props
}: LogoProps) => (
	<Group gap="sm" h="36px" align="center" {...props}>
		{!hideLogo && (
			<img
				src={logomark}
				alt="Dembrane Logo"
				className="h-full object-contain"
			/>
		)}
		{!hideTitle && (
			<img src={wordmark} alt="dembrane" className="h-[36px] object-contain" />
		)}
		{textAfterLogo && (
			<span className="text-xl font-medium">{textAfterLogo}</span>
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
