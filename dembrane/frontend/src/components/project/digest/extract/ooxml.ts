import { strFromU8, unzipSync } from "fflate";
import { attr, paragraphs, tokens } from "./xml";

/**
 * Text from Word (.docx) and PowerPoint (.pptx) files: they are zip archives of XML, read
 * with fflate in the browser. Word: the document body's paragraphs, tables included, in
 * order. PowerPoint: each slide's text in the presentation's order, then its speaker notes.
 * Headers, footers, comments, slide numbers and deleted text are left out.
 */

export class UnreadableFile extends Error {
	override name = "UnreadableFile";
}

function unzip(bytes: Uint8Array): Record<string, Uint8Array> {
	try {
		return unzipSync(bytes);
	} catch {
		throw new UnreadableFile("not a zip archive");
	}
}

const read = (files: Record<string, Uint8Array>, path: string) => {
	const f = files[path];
	return f ? strFromU8(f) : null;
};

export function docxText(bytes: Uint8Array): string {
	const files = unzip(bytes);
	const xml = read(files, "word/document.xml");
	if (xml === null) throw new UnreadableFile("no word/document.xml");
	return paragraphs(xml, {
		breaks: ["w:br", "w:cr"],
		paragraph: "w:p",
		// A text box's text is there twice: once for new readers, once as a fallback.
		skip: ["w:delText", "mc:Fallback", "w:instrText"],
		tab: ["w:tab"],
		text: ["w:t"],
	}).join("\n");
}

const SLIDE_RULES = {
	breaks: ["a:br"],
	paragraph: "a:p",
	skip: ["a:fld", "mc:Fallback"],
	text: ["a:t"],
} as const;

/** Relationship id to target, from a .rels file, resolved against `base`. */
function relationships(
	xml: string | null,
	base: string,
): Map<string, { target: string; type: string }> {
	const out = new Map<string, { target: string; type: string }>();
	if (!xml) return out;
	for (const t of tokens(xml)) {
		if (t.type !== "open" || !t.name.endsWith("Relationship")) continue;
		const id = attr(t.attrs, "Id");
		const target = attr(t.attrs, "Target");
		if (!id || !target) continue;
		out.set(id, {
			target: resolve(base, target),
			type: attr(t.attrs, "Type") ?? "",
		});
	}
	return out;
}

function resolve(base: string, target: string): string {
	if (target.startsWith("/")) return target.slice(1);
	const parts = base.split("/").filter(Boolean);
	for (const seg of target.split("/")) {
		if (seg === "..") parts.pop();
		else if (seg !== ".") parts.push(seg);
	}
	return parts.join("/");
}

/** The slide files in the presentation's own order; by number when that is missing. */
function slideOrder(files: Record<string, Uint8Array>): string[] {
	const rels = relationships(
		read(files, "ppt/_rels/presentation.xml.rels"),
		"ppt",
	);
	const ordered: string[] = [];
	const presentation = read(files, "ppt/presentation.xml");
	if (presentation)
		for (const t of tokens(presentation)) {
			if (t.type !== "open" || t.name !== "p:sldId") continue;
			const id = attr(t.attrs, "r:id");
			const target = id ? rels.get(id)?.target : undefined;
			if (target && files[target]) ordered.push(target);
		}
	if (ordered.length) return ordered;
	const number = (p: string) => Number(/slide(\d+)\.xml$/.exec(p)?.[1] ?? 0);
	return Object.keys(files)
		.filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
		.sort((a, b) => number(a) - number(b));
}

export function pptxText(bytes: Uint8Array): string {
	const files = unzip(bytes);
	const slides = slideOrder(files);
	if (!slides.length) throw new UnreadableFile("no slides");
	const out: string[] = [];
	slides.forEach((path, i) => {
		const text = paragraphs(read(files, path) ?? "", SLIDE_RULES);
		const dir = path.slice(0, path.lastIndexOf("/"));
		const name = path.slice(path.lastIndexOf("/") + 1);
		const rels = relationships(read(files, `${dir}/_rels/${name}.rels`), dir);
		const notesPath = [...rels.values()].find((r) =>
			r.type.endsWith("/notesSlide"),
		)?.target;
		const notes = notesPath
			? paragraphs(read(files, notesPath) ?? "", SLIDE_RULES)
			: [];
		if (!text.length && !notes.length) return;
		const block = [`Slide ${i + 1}`, ...text];
		if (notes.length) block.push(`Speaker notes: ${notes.join(" ")}`);
		out.push(block.join("\n"));
	});
	return out.join("\n\n");
}
