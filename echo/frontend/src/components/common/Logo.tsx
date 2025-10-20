import { Group, type GroupProps, Title } from "@mantine/core";
import aiconlLogo from "@/assets/aiconl-logo.png";
import aiconlLogoHQ from "@/assets/aiconl-logo-hq.png";
import dembranelogo from "@/assets/dembrane-logo-hq.png";
import { cn } from "@/lib/utils";

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
	<Group gap="sm" h="30px" align="center" {...props}>
		{!hideLogo && (
			<img
				src={dembranelogo}
				alt="Dembrane Logo"
				className="h-full object-contain"
			/>
		)}
		{!hideTitle && (
			<Title order={1} className="text-xl">
				<span className={cn("font-medium", textAfterLogo && "mr-1")}>
					Dembrane
				</span>
				{textAfterLogo && <span>{textAfterLogo}</span>}
			</Title>
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
