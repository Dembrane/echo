import { Paper, Stack, Text } from "@mantine/core";
import type React from "react";
import { cn } from "@/lib/utils";
import { MODE_COLORS } from "./ChatModeSelector";

type ChatMode = "overview" | "deep_dive" | null;

type Props = {
	children?: React.ReactNode;
	section?: React.ReactNode;
	role: "user" | "dembrane" | "assistant";
	chatMode?: ChatMode;
};

// Get border color based on chat mode
const getBorderColor = (chatMode: ChatMode | undefined): string | undefined => {
	if (chatMode === "deep_dive") return MODE_COLORS.deep_dive.border;
	if (chatMode === "overview") return MODE_COLORS.overview.border;
	return undefined;
};

export const ChatMessage = ({ children, section, role, chatMode }: Props) => {
	const borderColor = getBorderColor(chatMode);

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
						"max-w-full rounded-t-md border p-4 shadow-sm md:max-w-[80%]",
						role === "user"
							? "rounded-bl-md rounded-br-none"
							: "rounded-bl-none rounded-br-md border-slate-200",
					)}
					style={role === "user" && borderColor ? { borderColor } : undefined}
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
