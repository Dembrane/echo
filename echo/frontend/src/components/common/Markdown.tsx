import { useEffect, useMemo } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
	escapeRedactedTokens,
	REDACTED_CODE_PREFIX,
	RedactedBadge,
} from "@/components/common/RedactedText";
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

	const processedContent = useMemo(
		() => escapeRedactedTokens(content),
		[content],
	);

	const components = useMemo<Components>(
		() => ({
			code({ children, className: codeClassName, ...props }) {
				const text = String(children).trim();
				if (!codeClassName && text.startsWith(REDACTED_CODE_PREFIX)) {
					const type = text.slice(REDACTED_CODE_PREFIX.length);
					return <RedactedBadge type={type} />;
				}
				return (
					<code className={codeClassName} {...props}>
						{children}
					</code>
				);
			},
		}),
		[],
	);

	return (
		<ReactMarkdown
			className={cn(
				"prose prose-table:block prose-table:w-full prose-table:overflow-x-scroll",
				className,
			)}
			remarkPlugins={[remarkGfm]}
			components={components}
		>
			{processedContent}
		</ReactMarkdown>
	);
};
