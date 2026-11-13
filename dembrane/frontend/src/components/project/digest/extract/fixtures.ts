import { strToU8, zipSync } from "fflate";

/**
 * Small documents for the extractor tests, written here (no binary fixtures): a PDF with
 * a text layer, a PDF without one (as a scan has), a .docx and a .pptx with speaker notes.
 */

const escPdf = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);

/** A PDF with one page per entry; each page shows its lines, or nothing for null. */
export function makePdf(pages: (string[] | null)[]): Uint8Array {
	const objects: string[] = [];
	const add = (body: string) => {
		objects.push(body);
		return objects.length;
	};
	const catalog = add("");
	const pagesId = add("");
	const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
	const kids: number[] = [];
	for (const lines of pages) {
		const content = lines
			? `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((l) => `(${escPdf(l)}) Tj T*`).join(" ")} ET`
			: "0.9 g 72 72 468 648 re f";
		const stream = add(
			`<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
		);
		kids.push(
			add(
				`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${stream} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
			),
		);
	}
	objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
	objects[pagesId - 1] =
		`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
	let out = "%PDF-1.4\n";
	const offsets: number[] = [];
	objects.forEach((body, i) => {
		offsets.push(out.length);
		out += `${i + 1} 0 obj\n${body}\nendobj\n`;
	});
	const xref = out.length;
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
	out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return strToU8(out, true);
}

const xmlEsc = (s: string) =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const W =
	'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const P =
	'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** A .docx whose body has these paragraphs; a paragraph's runs split at "|". */
export function makeDocx(paragraphs: string[]): Uint8Array {
	const body = paragraphs
		.map(
			(p) =>
				`<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr>${p
					.split("|")
					.map(
						(run) =>
							`<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${xmlEsc(run)}</w:t></w:r>`,
					)
					.join("")}</w:p>`,
		)
		.join("");
	return zipSync({
		"[Content_Types].xml": strToU8('<?xml version="1.0"?><Types/>'),
		"word/document.xml": strToU8(
			`<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`,
		),
		"word/styles.xml": strToU8(
			`<w:styles ${W}><w:style><w:name w:val="Not text"/></w:style></w:styles>`,
		),
	});
}

/**
 * A .pptx with these slides, in `order` (the presentation's order, which need not be the
 * file numbers), each with its paragraphs and optional speaker notes.
 */
export function makePptx(
	slides: { lines: string[]; notes?: string[] }[],
	order: number[] = slides.map((_, i) => i + 1),
): Uint8Array {
	const files: Record<string, Uint8Array> = {
		"[Content_Types].xml": strToU8('<?xml version="1.0"?><Types/>'),
	};
	const para = (l: string) =>
		`<a:p><a:r><a:rPr lang="nl-NL"/><a:t>${xmlEsc(l)}</a:t></a:r></a:p>`;
	slides.forEach((s, i) => {
		const n = i + 1;
		files[`ppt/slides/slide${n}.xml`] = strToU8(
			`<p:sld ${P} ${A}><p:cSld><p:spTree><p:sp><p:txBody>${s.lines.map(para).join("")}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
		);
		if (s.notes) {
			files[`ppt/notesSlides/notesSlide${n}.xml`] = strToU8(
				`<p:notes ${P} ${A}><p:cSld><p:spTree><p:sp><p:txBody>${s.notes.map(para).join("")}</p:txBody></p:sp><p:sp><p:txBody><a:p><a:fld type="slidenum"><a:t>${n}</a:t></a:fld></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
			);
			files[`ppt/slides/_rels/slide${n}.xml.rels`] = strToU8(
				`<Relationships><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${n}.xml"/></Relationships>`,
			);
		}
	});
	files["ppt/presentation.xml"] = strToU8(
		`<p:presentation ${P}><p:sldIdLst>${order.map((n, i) => `<p:sldId id="${256 + i}" r:id="rIdS${n}"/>`).join("")}</p:sldIdLst></p:presentation>`,
	);
	files["ppt/_rels/presentation.xml.rels"] = strToU8(
		`<Relationships>${slides.map((_, i) => `<Relationship Id="rIdS${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join("")}</Relationships>`,
	);
	return zipSync(files);
}
