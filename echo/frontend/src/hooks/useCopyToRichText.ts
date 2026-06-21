import { t } from "@lingui/core/macro";
import { useCallback, useEffect, useState } from "react";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { toast } from "@/components/common/Toaster";

async function markdownToHtml(markdown: string): Promise<string> {
	const result = await unified()
		.use(remarkParse) // Parse Markdown content
		.use(remarkGfm) // Support GFM (GitHub Flavored Markdown)
		.use(remarkRehype) // Convert to HTML AST
		.use(rehypeStringify) // Convert HTML AST to HTML string
		.process(markdown); // Process the Markdown input

	return String(result);
}

function useCopyToRichText() {
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		if (copied) {
			const timeout = setTimeout(() => {
				setCopied(false);
			}, 500);

			return () => clearTimeout(timeout);
		}
	}, [copied]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: needs to be fixed
	const copy = useCallback(
		(input: string | Promise<string> | (() => Promise<string>)) => {
			let textPromise: Promise<string>;
			if (typeof input === "string") {
				textPromise = Promise.resolve(input);
			} else if (input instanceof Promise) {
				textPromise = input;
			} else if (typeof input === "function") {
				textPromise = input();
			} else {
				textPromise = Promise.resolve("");
			}

			const htmlPromise = textPromise.then(async (markdown) => {
				return await markdownToHtml(markdown);
			});

			const textBlobPromise = textPromise.then(
				(text) => new Blob([text], { type: "text/plain" }),
			);
			const htmlBlobPromise = htmlPromise.then(
				(html) => new Blob([html], { type: "text/html" }),
			);

			const clipboardItem = new ClipboardItem({
				"text/plain": textBlobPromise,
				"text/html": htmlBlobPromise,
			});

			return navigator.clipboard.write([clipboardItem]).then(
				() => {
					setCopied(true);
				},
				async (err) => {
					console.error("Rich text copy failed, trying fallback:", err);
					const text = await textPromise;
					if (navigator.clipboard?.writeText) {
						try {
							await navigator.clipboard.writeText(text);
							setCopied(true);
						} catch (e) {
							console.error("writeText fallback failed:", e);
							toast.error(t`Could not copy to clipboard. Please try again.`);
							throw e;
						}
					} else {
						toast.error(t`Could not copy to clipboard. Please try again.`);
						throw err;
					}
				},
			);
		},
		[setCopied],
	);

	return {
		copied,
		copy,
	};
}

export default useCopyToRichText;
