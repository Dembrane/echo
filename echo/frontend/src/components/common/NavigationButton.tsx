import { cn } from "@/lib/utils";
import {
  Box,
  Group,
  Paper,
  PolymorphicComponentProps,
  Text,
  UnstyledButton,
  UnstyledButtonProps,
  Tooltip,
} from "@mantine/core";
import { PropsWithChildren } from "react";
import { Link } from "react-router-dom";
import { I18nLink } from "@/components/common/i18nLink";
import { LoadingSpinner } from "./LoadingSpinner";

type Props = {
  to?: string;
  borderColor?: string;
  rightIcon?: React.ReactNode;
  rightSection?: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  loading?: boolean;
  loadingTooltip?: string;
  disabledTooltip?: string;
} & PolymorphicComponentProps<"a" | "button", UnstyledButtonProps>;

export const NavigationButton = ({
  children,
  to,
  borderColor,
  rightSection,
  rightIcon,
  active,
  disabled = false,
  loading = false,
  loadingTooltip,
  disabledTooltip,
  ...props
}: PropsWithChildren<Props>) => {
  const rightContent = loading ? (
    <Tooltip label={loadingTooltip} disabled={!loadingTooltip}>
      <span>
        <LoadingSpinner size="sm" />
      </span>
    </Tooltip>
  ) : (
    rightIcon
  );

  const content = (
    <Paper
      className={cn(
        "w-full border border-gray-200 bg-white transition-colors",
        active ? "border-primary-500" : "",
        disabled || loading
          ? "opacity-60 hover:border-gray-300"
          : borderColor === "green" ? `hover:border-green-500` : "hover:border-primary-500",
        props.className,
      )}
    >
      <Group align="center" wrap="nowrap">
        {to ? (
          <I18nLink to={to} className="flex-grow px-4 py-2 max-w-full">
            <UnstyledButton
              {...props}
              className={cn(
                "w-full text-left",
                disabled ? "cursor-not-allowed" : "cursor-pointer",
              )}
            >
              <Group className="w-full justify-between">
                <Text size="lg" className="font-semibold max-w-full flex-1">
                  {children}
                </Text>
                {!!rightContent && rightContent}
              </Group>
            </UnstyledButton>
          </I18nLink>
        ) : (
          <UnstyledButton
            // @ts-ignore
            disabled={disabled ?? false}
            {...props}
            className={cn(
              "h-full w-full px-4 py-2 text-left",
              disabled ? "cursor-not-allowed" : "cursor-pointer",
            )}
          >
            <Group className="h-full w-full justify-between">
              <Text size="lg" className="font-semibold">
                {children}
              </Text>
              {!!rightContent && rightContent}
            </Group>
          </UnstyledButton>
        )}

        {!!rightSection && (
          <div
            onClick={(e) => {
              e.stopPropagation(); // Prevent the main link from being activated
            }}
            className="mx-2 h-full"
          >
            {rightSection}
          </div>
        )}
      </Group>
    </Paper>
  );

  return disabled && disabledTooltip ? (
    <Tooltip label={disabledTooltip}>{content}</Tooltip>
  ) : (
    content
  );
};
