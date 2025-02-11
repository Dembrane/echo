import { Group, GroupProps, Title } from "@mantine/core";
import dembranelogo from "@/assets/dembrane-logo-hq.png";
import aiconlLogo from "@/assets/aiconl-logo.png";
import aiconlLogoHQ from "@/assets/aiconl-logo-hq.png";

type LogoProps = {
  hideLogo?: boolean;
  hideTitle?: boolean;
  otherText?: string;
} & GroupProps;

export const LogoDembrane = ({
  hideLogo,
  hideTitle,
  otherText,
  ...props
}: LogoProps) => (
  <Group gap="sm" h="30px" {...props}>
    {!hideLogo && (
      <img
        src={dembranelogo}
        alt="Dembrane Logo"
        className="h-full object-contain"
      />
    )}
    {!hideTitle && (
      <Title order={1} className="text-xl">
        {otherText ? <div className="">{otherText}</div> : "Dembrane"}
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

export const CURRENT_BRAND: "dembrane" | "aiconl" = "aiconl";

export const Logo = (props: LogoProps) => {
  // @ts-ignore
  return CURRENT_BRAND === "dembrane" ? (
    <LogoDembrane {...props} />
  ) : (
    <LogoAiCoNL {...props} />
  );
};
