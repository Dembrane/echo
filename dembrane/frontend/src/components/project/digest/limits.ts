/**
 * What the drop zone takes and how much (ECHO-1055). Files never leave the browser: their
 * text is extracted here and only the text, the file name, its kind and its length are
 * sent. The server holds to the same total (DIGEST_BOUNDS in platform/packages/projects).
 */
export const MAX_FILES = 5;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_CHARS = 200_000;
/** The same as the platform's prompt budget and the context field's note. */
export const CONTEXT_BUDGET = 4_000;

export type FileKind = "pdf" | "docx" | "pptx" | "text";

/** What the file dialog offers and the drop zone takes, by type and extension. */
export const DIGEST_ACCEPT: Record<string, string[]> = {
	"application/pdf": [".pdf"],
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": [
		".pptx",
	],
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": [
		".docx",
	],
	"text/markdown": [".md", ".markdown"],
	"text/plain": [".txt"],
};

/** Why a file is not read; each has its own message. */
export type FileRefusal =
	| "too_many"
	| "too_large"
	| "legacy_format"
	| "spreadsheet"
	| "image"
	| "unsupported"
	| "scanned_pdf"
	| "empty"
	| "unreadable"
	| "over_total";

const extension = (name: string) => (name.split(".").pop() ?? "").toLowerCase();

/** What a file is, from its extension first and its type second, or why it is refused. */
export function classifyFile(file: {
	name: string;
	type: string;
}): { kind: FileKind } | { refused: FileRefusal } {
	const ext = extension(file.name);
	const type = file.type.toLowerCase();
	if (ext === "pdf" || type === "application/pdf") return { kind: "pdf" };
	if (ext === "docx") return { kind: "docx" };
	if (ext === "pptx") return { kind: "pptx" };
	if (["txt", "md", "markdown"].includes(ext)) return { kind: "text" };
	if (["doc", "ppt", "pps", "rtf", "odt", "odp", "pages", "key"].includes(ext))
		return { refused: "legacy_format" };
	if (["xls", "xlsx", "xlsm", "csv", "ods", "numbers"].includes(ext))
		return { refused: "spreadsheet" };
	if (
		type.startsWith("image/") ||
		[
			"heic",
			"jpg",
			"jpeg",
			"png",
			"gif",
			"webp",
			"svg",
			"tif",
			"tiff",
		].includes(ext)
	)
		return { refused: "image" };
	if (!ext && (type === "text/plain" || type === "text/markdown"))
		return { kind: "text" };
	return { refused: "unsupported" };
}

/** The start of `text`, at most `max` characters, cut at a paragraph, line or sentence. */
export function cutToBudget(text: string, max = CONTEXT_BUDGET): string {
	if (text.length <= max) return text;
	const head = text.slice(0, max);
	const floor = max * 0.6;
	for (const sep of ["\n\n", "\n"]) {
		const at = head.lastIndexOf(sep);
		if (at >= floor) return head.slice(0, at).trimEnd();
	}
	const sentence = Math.max(
		head.lastIndexOf(". "),
		head.lastIndexOf("? "),
		head.lastIndexOf("! "),
	);
	if (sentence >= floor) return head.slice(0, sentence + 1);
	const space = head.lastIndexOf(" ");
	return (space >= floor ? head.slice(0, space) : head).trimEnd();
}
