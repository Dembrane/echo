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
import "./styles.css";

export function MarkdownWYSIWYG(props: MDXEditorProps) {
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
			contentEditableClassName="prose min-h-[200px] space-grotesk"
			className="rounded border border-gray-200"
			{...props}
		/>
	);
}
