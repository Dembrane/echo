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


// If the hostnames ever change we will need to update these 
// ideally make these public Vite vars but im lazy
const DEV_HOSTNAMES = new Set([
	"dashboard.echo-testing.dembrane.com",
	"portal.echo-testing.dembrane.com",
]);

const STAGING_HOSTNAMES = new Set([
	"dashboard.echo-next.dembrane.com",
	"portal.echo-next.dembrane.com",
]);

const LOCAL_HOSTNAMES = new Set([
	"localhost:5173",
	"localhost:5174",
]);


const whichHost = () => {
	if (DEV_HOSTNAMES.has(window.location.host)) {
		return "dev";
	}
	if (STAGING_HOSTNAMES.has(window.location.host)) {
		return "staging";
	}
	if (LOCAL_HOSTNAMES.has(window.location.host)) {
		return "local";
	}
	return null;
};


export const LogoDembrane = ({ hideLogo, hideTitle, alwaysDembrane, ...props }: LogoProps) => {
	const { logoUrl } = useWhitelabelLogo();
	const effectiveLogoUrl = alwaysDembrane ? null : logoUrl;

	return (
		<Group gap="sm" h="32px" align="center" {...props}>
			{!hideLogo && effectiveLogoUrl === undefined ? (
				<Loader size={24} color="gray" ml="xl" />
			) : !hideLogo ? (
				<span className="relative inline-flex h-full items-center">
					<img
						src={effectiveLogoUrl ?? (hideTitle ? dembraneLogomark : dembraneLogoFull)}
						alt="Logo"
						className="h-full object-contain"
					/>
					{whichHost() && (
						<span
							className="pointer-events-none absolute capitalize -bottom-1 -right-[15px] -translate-x-1/2 pl-1 text-[10px] font-medium leading-none"
							style={{ color: "var(--mantine-color-primary-6)" }}
						>
							{whichHost()}
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
