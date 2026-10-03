import {
	BlockTypeSelect,
	BoldItalicUnderlineToggles,
	CreateLink,
	headingsPlugin,
	ListsToggle,
	linkDialogPlugin,
	listsPlugin,
	MDXEditor,
	type MDXEditorProps,
	markdownShortcutPlugin,
	quotePlugin,
	thematicBreakPlugin,
	toolbarPlugin,
	UndoRedo,
} from "@mdxeditor/editor";
import { useCallback, useMemo } from "react";

import "./styles.css";
import {
	escapeRedactedTokens,
	unescapeRedactedTokens,
} from "@/components/common/RedactedText";

export function MarkdownWYSIWYG({
	markdown,
	onChange,
	...rest
}: MDXEditorProps) {
	const safeMarkdown = useMemo(
		() => escapeRedactedTokens(markdown ?? ""),
		[markdown],
	);

	const handleChange = useCallback(
		(value: string, initialMarkdownNormalize: boolean) => {
			onChange?.(unescapeRedactedTokens(value), initialMarkdownNormalize);
		},
		[onChange],
	);

	return (
		<MDXEditor
			plugins={[
				thematicBreakPlugin(),
				headingsPlugin(),
				quotePlugin(),
				linkDialogPlugin(),
				listsPlugin(),
				markdownShortcutPlugin(),
				toolbarPlugin({
					toolbarContents: () => (
						<>
							<BoldItalicUnderlineToggles />
							<CreateLink />
							<ListsToggle options={["number", "bullet"]} />
							<BlockTypeSelect />
							<UndoRedo />
						</>
					),
				}),
			]}
			contentEditableClassName="prose min-h-[200px]"
			className="border-x border-solid border-[color:var(--app-control-rule)]"
			{...rest}
			markdown={safeMarkdown}
			onChange={handleChange}
		/>
	);
}
