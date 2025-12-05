import {
	Group,
	Paper,
	type PolymorphicComponentProps,
	Text,
	Tooltip,
	UnstyledButton,
	type UnstyledButtonProps,
} from "@mantine/core";
import type { PropsWithChildren } from "react";
import { I18nLink } from "@/components/common/i18nLink";
import { cn } from "@/lib/utils";
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
				"w-full border border-gray-200 transition-colors",
				active && !borderColor ? "border-primary-500" : "",
				disabled || loading
					? "opacity-60 hover:border-gray-300"
					: borderColor === "green"
						? "hover:border-green-500"
						: borderColor
							? "" // custom borderColor handled via style
							: "hover:border-primary-500",
				props.className,
			)}
			style={{
				backgroundColor: "var(--app-background)",
				...(borderColor && borderColor !== "green" ? { borderColor } : {}),
			}}
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
					<UnstyledButton
						onClick={(e) => {
							e.stopPropagation(); // Prevent the main link from being activated
						}}
						className="mx-2 h-full"
					>
						{rightSection}
					</UnstyledButton>
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
