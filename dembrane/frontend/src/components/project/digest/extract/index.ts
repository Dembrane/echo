import {
	classifyFile,
	type FileKind,
	type FileRefusal,
	MAX_FILE_BYTES,
	MAX_FILES,
	MAX_TOTAL_CHARS,
} from "../limits";
import { docxText, pptxText, UnreadableFile } from "./ooxml";
import { pdfText } from "./pdf";
import { plainText, tidyText } from "./text";

/**
 * Reading the files a host drops, in the browser (ECHO-1055). Each file is read on its
 * own: one that fails says why and the others go on. Nothing here sends, stores or logs a
 * file or its text; the caller sends the text, the name, the kind and the length only.
 */

export type ExtractedFile =
	| {
			name: string;
			kind: FileKind;
			status: "ok";
			text: string;
			chars: number;
			/** The text was cut to stay within the total. */
			cut: boolean;
	  }
	| {
			name: string;
			kind: FileKind | null;
			status: "refused";
			reason: FileRefusal;
	  };

export interface ExtractOptions {
	/** Characters already taken by pasted text, counted towards the total. */
	alreadyChars?: number;
	signal?: AbortSignal;
	/** Called as each file starts and ends, by its index. */
	onProgress?: (index: number, state: "reading" | ExtractedFile) => void;
	/** pdf.js, replaceable in tests. */
	pdf?: typeof pdfText;
}

/** The text of one file by its kind; throws UnreadableFile or a refusal reason. */
async function textOf(
	kind: FileKind,
	bytes: Uint8Array,
	o: ExtractOptions,
): Promise<string> {
	if (kind === "pdf") {
		const pdf = await (o.pdf ?? pdfText)(bytes, o.signal);
		if (!pdf.hasTextLayer) throw new Refused("scanned_pdf");
		return pdf.text;
	}
	if (kind === "docx") return docxText(bytes);
	if (kind === "pptx") return pptxText(bytes);
	return plainText(bytes);
}

class Refused extends Error {
	constructor(readonly reason: FileRefusal) {
		super(reason);
	}
}

const isAbort = (err: unknown) =>
	err instanceof DOMException && err.name === "AbortError";

export async function extractFiles(
	files: readonly File[],
	o: ExtractOptions = {},
): Promise<ExtractedFile[]> {
	const out: ExtractedFile[] = [];
	let total = o.alreadyChars ?? 0;
	let taken = 0;
	for (const [i, file] of files.entries()) {
		if (o.signal?.aborted)
			throw o.signal.reason ?? new DOMException("Aborted", "AbortError");
		const classified = classifyFile(file);
		const done = (r: ExtractedFile) => {
			out.push(r);
			o.onProgress?.(i, r);
		};
		if ("refused" in classified) {
			done({
				kind: null,
				name: file.name,
				reason: classified.refused,
				status: "refused",
			});
			continue;
		}
		const { kind } = classified;
		if (taken >= MAX_FILES) {
			done({ kind, name: file.name, reason: "too_many", status: "refused" });
			continue;
		}
		taken++;
		if (file.size > MAX_FILE_BYTES) {
			done({ kind, name: file.name, reason: "too_large", status: "refused" });
			continue;
		}
		if (total >= MAX_TOTAL_CHARS) {
			done({ kind, name: file.name, reason: "over_total", status: "refused" });
			continue;
		}
		o.onProgress?.(i, "reading");
		try {
			const bytes = new Uint8Array(await file.arrayBuffer());
			let text = tidyText(await textOf(kind, bytes, o));
			if (!text) throw new Refused("empty");
			const room = MAX_TOTAL_CHARS - total;
			const cut = text.length > room;
			if (cut) text = text.slice(0, room);
			total += text.length;
			done({
				chars: text.length,
				cut,
				kind,
				name: file.name,
				status: "ok",
				text,
			});
		} catch (err) {
			if (isAbort(err) || o.signal?.aborted) throw err;
			const reason: FileRefusal =
				err instanceof Refused ? err.reason : "unreadable";
			done({ kind, name: file.name, reason, status: "refused" });
		}
	}
	return out;
}

export { UnreadableFile };
