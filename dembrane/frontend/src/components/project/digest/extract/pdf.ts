/**
 * Text from a PDF's text layer with pdf.js, in the browser, page by page. No rendering and
 * no OCR: a scan (pages that are only pictures) has no text layer and is refused with its
 * own message. pdf.js and its worker load with this module, which only the digest's
 * extraction imports, so neither the portal nor the dashboard's first load pays for them.
 */

interface TextItemLike {
	str?: string;
	transform?: number[];
	width?: number;
	hasEOL?: boolean;
}

export interface PdfPageLike {
	getTextContent(): Promise<{ items: unknown[] }>;
	cleanup?(): void;
}

export interface PdfDocumentLike {
	numPages: number;
	getPage(n: number): Promise<PdfPageLike>;
	destroy?(): Promise<void>;
}

/** At most this many pages are read; past that the rest is left out (and the text is long). */
export const MAX_PDF_PAGES = 300;

/** One page's text: items on a line joined, a gap made a space, a new line where y moves. */
export function pageText(items: readonly unknown[]): string {
	let out = "";
	let lastY: number | null = null;
	let lastEnd: number | null = null;
	for (const raw of items) {
		const item = raw as TextItemLike;
		if (typeof item.str !== "string") continue;
		const [, , , height = 0, x = 0, y = 0] = item.transform ?? [];
		const size = Math.abs(height) || 10;
		if (lastY !== null && Math.abs(y - lastY) > size * 0.5) {
			if (!out.endsWith("\n")) out += "\n";
		} else if (
			lastEnd !== null &&
			x - lastEnd > size * 0.15 &&
			!/\s$/.test(out) &&
			!/^\s/.test(item.str)
		)
			out += " ";
		out += item.str;
		if (item.hasEOL) out += "\n";
		lastY = y;
		lastEnd = x + (item.width ?? 0);
	}
	return out
		.split("\n")
		.map((l) => l.replace(/[ \t ]+/g, " ").trim())
		.join("\n")
		.replace(/\n{2,}/g, "\n")
		.trim();
}

export interface PdfText {
	text: string;
	pages: number;
	/** False when the document has (almost) no text layer, as a scan has. */
	hasTextLayer: boolean;
}

export async function pdfDocumentText(
	doc: PdfDocumentLike,
	signal?: AbortSignal,
): Promise<PdfText> {
	const pages: string[] = [];
	const count = Math.min(doc.numPages, MAX_PDF_PAGES);
	for (let n = 1; n <= count; n++) {
		if (signal?.aborted)
			throw signal.reason ?? new DOMException("Aborted", "AbortError");
		const page = await doc.getPage(n);
		const content = await page.getTextContent();
		pages.push(pageText(content.items));
		page.cleanup?.();
	}
	const text = pages.filter(Boolean).join("\n\n");
	const letters = (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
	// A scan may still carry a page number or a stamp: under 16 letters a page is no text.
	const hasTextLayer = letters > 0 && letters >= Math.min(16 * count, 40);
	return { hasTextLayer, pages: count, text };
}

export async function pdfText(
	bytes: Uint8Array,
	signal?: AbortSignal,
): Promise<PdfText> {
	const [pdfjs, worker] = await Promise.all([
		import("pdfjs-dist"),
		import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
	]);
	if (!pdfjs.GlobalWorkerOptions.workerSrc && worker.default)
		pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
	const task = pdfjs.getDocument({
		data: bytes,
		disableFontFace: true,
		isEvalSupported: false,
		useSystemFonts: false,
	});
	const onAbort = () => void task.destroy();
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const doc = await task.promise;
		try {
			return await pdfDocumentText(doc, signal);
		} finally {
			await doc.destroy();
		}
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}
