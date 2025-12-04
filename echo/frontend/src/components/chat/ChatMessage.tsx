import { Paper, Stack, Text } from "@mantine/core";
import type React from "react";
import { cn } from "@/lib/utils";

type ChatMode = "overview" | "deep_dive" | null;

type Props = {
	children?: React.ReactNode;
	section?: React.ReactNode;
	role: "user" | "dembrane" | "assistant";
	chatMode?: ChatMode;
};

// Mode-specific colors for user messages (consistent with MODE_COLORS)
const USER_MESSAGE_STYLES: Record<string, string> = {
	overview: "!bg-amber-50 border-amber-200/60",
	deep_dive: "!bg-purple-50 border-purple-200/60",
	default: "!bg-primary-100 border-slate-200",
};

export const ChatMessage = ({ children, section, role, chatMode }: Props) => {
	const userStyle =
		USER_MESSAGE_STYLES[chatMode ?? "default"] ?? USER_MESSAGE_STYLES.default;

	return (
		<div
			className={cn(
				"flex",
				["user", "dembrane"].includes(role) ? "justify-end" : "justify-start",
			)}
		>
			{role === "dembrane" && (
				<Text size="sm" className="italic">
					{children}
				</Text>
			)}
			{["user", "assistant"].includes(role) && (
				<Paper
					className={cn(
						"max-w-full rounded-t-xl border p-4 shadow-sm md:max-w-[80%]",
						role === "user"
							? `rounded-bl-xl rounded-br-none ${userStyle}`
							: "rounded-bl-none rounded-br-xl border-slate-200",
					)}
				>
					<Stack gap="xs">
						<div>{children}</div>
						{section && <div>{section}</div>}
					</Stack>
				</Paper>
			)}
		</div>
	);
};
