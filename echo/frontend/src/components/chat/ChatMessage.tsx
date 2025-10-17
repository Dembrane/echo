import { Paper, Stack, Text } from "@mantine/core";
import type React from "react";
import { cn } from "@/lib/utils";

type Props = {
	children?: React.ReactNode;
	section?: React.ReactNode;
	role: "user" | "dembrane" | "assistant";
};

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
				<Paper
					className={cn(
						"max-w-full rounded-t-xl border border-slate-200 p-4 shadow-sm md:max-w-[80%]",
						role === "user"
							? "rounded-bl-xl rounded-br-none !bg-primary-100"
							: "rounded-bl-none rounded-br-xl",
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
