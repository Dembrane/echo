import { Paper, Stack, Text } from "@mantine/core";
import type React from "react";
import { cn } from "@/lib/utils";

type ChatMode = "overview" | "deep_dive" | "agentic" | null;

type Props = {
	children?: React.ReactNode;
	section?: React.ReactNode;
	role: "user" | "dembrane" | "assistant";
	chatMode?: ChatMode;
};

// Every bubble is neutral, whatever the mode: a mode's colour lives in its
// mark, not on the messages.
export const ChatMessage = ({ children, section, role }: Props) => {
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
				<Paper className="max-w-full p-4 md:max-w-[80%]">
					<Stack gap="xs">
						<div>{children}</div>
						{section && <div>{section}</div>}
					</Stack>
				</Paper>
			)}
		</div>
	);
};
