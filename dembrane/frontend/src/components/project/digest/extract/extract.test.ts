import { strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { classifyFile, cutToBudget, MAX_TOTAL_CHARS } from "../limits";
import { makeDocx, makePdf, makePptx } from "./fixtures";
import { extractFiles } from "./index";
import { docxText, pptxText, UnreadableFile } from "./ooxml";
import { pageText, pdfDocumentText, pdfText } from "./pdf";
import { plainText, tidyText } from "./text";
import { decodeEntities } from "./xml";

vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));

const file = (bytes: Uint8Array | string, name: string, type = "") =>
	new File([typeof bytes === "string" ? bytes : bytes], name, { type });

describe("pdf", () => {
	it("reads the text layer, line by line, page by page", async () => {
		const pdf = await pdfText(
			makePdf([
				["Uitnodiging bewonersavond Strijp-S", "Ronde 1: Wat gaat goed?"],
				["Ronde 2: Wat moet anders (en waarom)?"],
			]),
		);
		expect(pdf.pages).toBe(2);
		expect(pdf.hasTextLayer).toBe(true);
		expect(pdf.text).toBe(
			"Uitnodiging bewonersavond Strijp-S\nRonde 1: Wat gaat goed?\n\nRonde 2: Wat moet anders (en waarom)?",
		);
	});

	it("a PDF of pictures only has no text layer", async () => {
		const pdf = await pdfText(makePdf([null, null]));
		expect(pdf.hasTextLayer).toBe(false);
		expect(pdf.text).toBe("");
	});

	it("a scan with a stamp or page number is still a scan", async () => {
		const doc = {
			getPage: async () => ({
				getTextContent: async () => ({
					items: [{ str: "3", transform: [1, 0, 0, 10, 0, 0] }],
				}),
			}),
			numPages: 4,
		};
		expect((await pdfDocumentText(doc)).hasTextLayer).toBe(false);
	});

	it("joins items on a line with a space only where there is a gap", () => {
		const at = (str: string, x: number, y: number, width: number) => ({
			str,
			transform: [10, 0, 0, 10, x, y],
			width,
		});
		expect(
			pageText([
				at("Klok", 0, 100, 20),
				at("gebouw", 20, 100, 30),
				at("Eindhoven", 56, 100, 40),
				at("Ronde 1", 0, 80, 30),
			]),
		).toBe("Klokgebouw Eindhoven\nRonde 1");
	});
});

describe("docx", () => {
	it("reads the body's paragraphs in order, runs joined, entities decoded", () => {
		const text = docxText(
			makeDocx([
				"Agenda bewonersavond",
				"19.30 |Welkom & koffie",
				"Ronde 1: <Wat gaat goed?>",
			]),
		);
		expect(text).toBe(
			"Agenda bewonersavond\n19.30 Welkom & koffie\nRonde 1: <Wat gaat goed?>",
		);
	});

	it("leaves out deleted text and a text box's fallback copy", () => {
		const W = 'xmlns:w="w"';
		const xml = `<w:document ${W}><w:body><w:p><w:r><w:t>Keep</w:t></w:r><w:del><w:r><w:delText>gone</w:delText></w:r></w:del></w:p><w:p><mc:AlternateContent><mc:Choice><w:t>Box</w:t></mc:Choice><mc:Fallback><w:t>Box</w:t></mc:Fallback></mc:AlternateContent></w:p></w:body></w:document>`;
		const bytes = zipSync({ "word/document.xml": strToU8(xml) });
		expect(docxText(bytes)).toBe("Keep\nBox");
	});

	it("something that is not a Word file is unreadable", () => {
		expect(() => docxText(strToU8("not a zip"))).toThrow(UnreadableFile);
		expect(() => docxText(zipSync({ "a.txt": strToU8("x") }))).toThrow(
			UnreadableFile,
		);
	});
});

describe("pptx", () => {
	it("reads slides in the presentation's order with their speaker notes, slide numbers left out", () => {
		const text = pptxText(
			makePptx(
				[
					{ lines: ["Strategiedag 2027", "Koers 2030"] },
					{
						lines: ["Werksessies"],
						notes: ["Vraag elke groep om drie acties."],
					},
					{ lines: ["Programma", "09.00 Opening"] },
				],
				[1, 3, 2],
			),
		);
		expect(text).toBe(
			[
				"Slide 1\nStrategiedag 2027\nKoers 2030",
				"Slide 2\nProgramma\n09.00 Opening",
				"Slide 3\nWerksessies\nSpeaker notes: Vraag elke groep om drie acties.",
			].join("\n\n"),
		);
	});

	it("without a presentation order, slides go by number", () => {
		const bytes = makePptx([{ lines: ["Eén"] }, { lines: ["Twee"] }]);
		expect(pptxText(bytes)).toContain("Slide 1\nEén\n\nSlide 2\nTwee");
	});
});

describe("text", () => {
	it("UTF-8, UTF-16 with its mark, and Windows-1252", () => {
		expect(plainText(strToU8("Café Ünal"))).toBe("Café Ünal");
		expect(plainText(new Uint8Array([0xff, 0xfe, 0x48, 0, 0x69, 0]))).toBe(
			"Hi",
		);
		expect(plainText(new Uint8Array([0x43, 0x61, 0x66, 0xe9]))).toBe("Café");
		expect(tidyText("a  \r\n\r\n\r\n\r\nb\u0000")).toBe("a\n\nb");
		expect(decodeEntities("&#x1F389; &#233; &unknown;")).toBe("🎉 é &unknown;");
	});
});

describe("which files", () => {
	it("works by extension, refuses the old formats, spreadsheets and pictures", () => {
		expect(classifyFile({ name: "Agenda.PDF", type: "" })).toEqual({
			kind: "pdf",
		});
		expect(classifyFile({ name: "notes.md", type: "" })).toEqual({
			kind: "text",
		});
		expect(classifyFile({ name: "a.doc", type: "application/msword" })).toEqual(
			{ refused: "legacy_format" },
		);
		expect(classifyFile({ name: "a.ppt", type: "" })).toEqual({
			refused: "legacy_format",
		});
		expect(classifyFile({ name: "a.xlsx", type: "" })).toEqual({
			refused: "spreadsheet",
		});
		expect(classifyFile({ name: "scan.jpg", type: "image/jpeg" })).toEqual({
			refused: "image",
		});
		expect(classifyFile({ name: "a.zip", type: "" })).toEqual({
			refused: "unsupported",
		});
	});

	it("cuts to the context budget at a boundary", () => {
		const text = `${"Een zin over het warmtenet. ".repeat(200)}`;
		const out = cutToBudget(text, 1000);
		expect(out.length).toBeLessThanOrEqual(1000);
		expect(out.endsWith(".")).toBe(true);
		expect(cutToBudget("kort")).toBe("kort");
	});
});

describe("extractFiles", () => {
	it("reads each file on its own; a failure is that file's and the others go on", async () => {
		const progress: string[] = [];
		const out = await extractFiles(
			[
				file(
					makePdf([["Uitnodiging"], ["Ronde 1: Wat gaat goed in de wijk?"]]),
					"uitnodiging.pdf",
				),
				file(makePdf([null]), "scan.pdf"),
				file("x", "oud.doc"),
				file(makeDocx(["Agenda", "Ronde 2"]), "agenda.docx"),
				file(strToU8("kapot"), "kapot.pptx"),
				file("Notities", "notities.md"),
			],
			{
				onProgress: (i, s) =>
					progress.push(`${i}:${typeof s === "string" ? s : s.status}`),
			},
		);
		expect(
			out.map((r) => [r.name, r.status === "ok" ? r.chars : r.reason]),
		).toEqual([
			[
				"uitnodiging.pdf",
				"Uitnodiging\n\nRonde 1: Wat gaat goed in de wijk?".length,
			],
			["scan.pdf", "scanned_pdf"],
			["oud.doc", "legacy_format"],
			["agenda.docx", "Agenda\nRonde 2".length],
			["kapot.pptx", "unreadable"],
			["notities.md", "Notities".length],
		]);
		expect(progress.slice(0, 3)).toEqual(["0:reading", "0:ok", "1:reading"]);
	});

	it("an empty file says so", async () => {
		expect((await extractFiles([file("", "leeg.txt")]))[0]).toMatchObject({
			reason: "empty",
		});
	});

	it("five files at most, ten megabytes each, 200,000 characters in all", async () => {
		const six = Array.from({ length: 6 }, (_, i) =>
			file(`Tekst ${i}`, `${i}.txt`),
		);
		const out = await extractFiles(six);
		expect(out.map((r) => r.status === "refused" && r.reason)).toEqual([
			false,
			false,
			false,
			false,
			false,
			"too_many",
		]);
		const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "groot.pdf");
		expect((await extractFiles([big]))[0]).toMatchObject({
			reason: "too_large",
		});
		const long = await extractFiles(
			[
				file("a".repeat(150_000), "a.txt"),
				file("b".repeat(80_000), "b.txt"),
				file("c", "c.txt"),
			],
			{ alreadyChars: 10_000 },
		);
		expect(
			long.map((r) => (r.status === "ok" ? [r.chars, r.cut] : r.reason)),
		).toEqual([
			[150_000, false],
			[MAX_TOTAL_CHARS - 160_000, true],
			"over_total",
		]);
	});

	it("stops when cancelled", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			extractFiles([file("x", "a.txt")], { signal: controller.signal }),
		).rejects.toBeTruthy();
	});
});
