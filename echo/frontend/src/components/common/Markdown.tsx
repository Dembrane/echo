import { useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

export const Markdown = ({
	content,
	className,
}: {
	content: string;
	className?: string;
}) => {
	// FIXME: workaround to load Tally embeds
	useEffect(() => {
		try {
			// biome-ignore lint/suspicious/noExplicitAny: needs to be fixed
			if ((window as any).Tally) {
				setTimeout(() => {
					// biome-ignore lint/suspicious/noExplicitAny: needs to be fixed
					(window as any).Tally.loadEmbeds();
				}, 500);
			}
		} catch (e) {
			console.error(e);
		}
	}, []);

	return (
		<ReactMarkdown
			className={cn(
				"prose prose-table:block prose-table:w-full prose-table:overflow-x-scroll",
				className,
			)}
			remarkPlugins={[remarkGfm]}
		>
			{content}
		</ReactMarkdown>
	);
};
