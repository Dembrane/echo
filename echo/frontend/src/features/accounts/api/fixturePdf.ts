import {
	PDFDocument,
	type PDFFont,
	type PDFPage,
	rgb,
	StandardFonts,
} from "pdf-lib";
import type { DocumentDetailT } from "../contract/contract.gen";

/**
 * PDFs for fixture mode, laid out like the offer templates in
 * platform/docs/accounts-reference so the signing screen shows a realistic document with
 * the fields where the fixtures place them. The backend renders the real ones; nothing
 * here ships in a normal build (the fixture backend is only imported in fixture mode).
 */

const A4: [number, number] = [595.28, 841.89];
const INK = rgb(0.18, 0.18, 0.17);
const MUTED = rgb(0.45, 0.45, 0.43);
const LINE = rgb(0.82, 0.82, 0.8);

/** The standard fonts are WinAnsi only; keep what they can draw. */
const safe = (text: string): string =>
	text
		.replace(/[\u2018\u2019]/g, "'")
		.replace(/[\u201c\u201d]/g, '"')
		.replace(/[\u2013\u2014]/g, "-")
		.replace(/[^\x20-\x7e\u00a0-\u00ff\u20ac]/g, "");

interface Fonts {
	regular: PDFFont;
	bold: PDFFont;
	italic: PDFFont;
}

const wrap = (
	text: string,
	font: PDFFont,
	size: number,
	width: number,
): string[] => {
	const lines: string[] = [];
	for (const paragraph of safe(text).split("\n")) {
		let line = "";
		for (const word of paragraph.split(" ")) {
			const next = line ? `${line} ${word}` : word;
			if (font.widthOfTextAtSize(next, size) > width && line) {
				lines.push(line);
				line = word;
			} else {
				line = next;
			}
		}
		lines.push(line);
	}
	return lines;
};

/** Draws wrapped text from a top offset in points; returns the new top offset. */
const para = (
	page: PDFPage,
	text: string,
	top: number,
	opts: {
		font: PDFFont;
		size?: number;
		x?: number;
		width?: number;
		color?: ReturnType<typeof rgb>;
	},
): number => {
	const size = opts.size ?? 10;
	const x = opts.x ?? 56;
	const width = opts.width ?? A4[0] - x - 56;
	let y = top;
	for (const line of wrap(text, opts.font, size, width)) {
		page.drawText(line, {
			color: opts.color ?? INK,
			font: opts.font,
			size,
			x,
			y: A4[1] - y - size,
		});
		y += size * 1.4;
	}
	return y;
};

const money = (cents: number, currency: string) =>
	`${currency === "EUR" ? "EUR " : `${currency} `}${(
		cents / 100
	).toLocaleString("nl-NL", {
		minimumFractionDigits: 2,
	})}`;

const letterhead = (
	page: PDFPage,
	fonts: Fonts,
	company: {
		name: string;
		address: string;
		vat: string;
		kvk: string;
		iban: string;
	},
) => {
	para(page, company.name, 48, { font: fonts.bold, size: 14 });
	const right = A4[0] - 56 - 200;
	let y = 48;
	for (const [k, v] of [
		["Address", company.address],
		["VAT", company.vat],
		["IBAN", company.iban],
		["KvK", company.kvk],
	]) {
		para(page, `${k}: ${v}`, y, {
			color: MUTED,
			font: fonts.regular,
			size: 8,
			width: 200,
			x: right,
		});
		y += 12;
	}
};

const DMB = {
	address: "Sint Janssingel 88, 's-Hertogenbosch, NL",
	iban: "NL49 RABO 0318910535",
	kvk: "89391438",
	name: "dembrane B.V.",
	vat: "NL864967433B01",
};

/** Labels and underlines where each field sits, so the page reads like the template. */
const drawFieldGuides = (
	page: PDFPage,
	doc: DocumentDetailT,
	pageNumber: number,
	fonts: Fonts,
) => {
	for (const f of doc.fields.filter((x) => x.page === pageNumber)) {
		const y = A4[1] * (1 - f.y - f.height);
		page.drawText(safe(f.label), {
			color: MUTED,
			font: fonts.regular,
			size: 9,
			x: 56,
			y: y + 3,
		});
		page.drawLine({
			color: LINE,
			end: { x: A4[0] * (f.x + f.width), y },
			start: { x: A4[0] * f.x, y },
			thickness: 0.6,
		});
	}
};

async function offerPdf(doc: DocumentDetailT, fonts: Fonts, pdf: PDFDocument) {
	const content = doc.content;
	const nl = doc.language === "nl";
	const p1 = pdf.addPage(A4);
	letterhead(p1, fonts, content?.company ?? DMB);
	let y = 130;
	y = para(p1, doc.title, y, { font: fonts.bold, size: 18 });
	y = para(
		p1,
		`${content?.date ?? ""} | Offer ID: ${doc.reference ?? ""}`,
		y + 2,
		{
			color: MUTED,
			font: fonts.regular,
			size: 9,
		},
	);
	y = para(
		p1,
		`${nl ? "Beste" : "Hi"} ${content?.person_name ?? ""},`,
		y + 18,
		{ font: fonts.regular },
	);
	y = para(
		p1,
		nl
			? "Hieronder vind je de details van je dembrane abonnement. Heb je vragen, stel ze gerust."
			: "Below you can find the details for your dembrane subscription. If you have any questions, don't hesitate to ask them.",
		y + 6,
		{ font: fonts.regular },
	);
	y += 18;
	const cols = [56, 330, 410, 470];
	const heads = nl
		? ["Omschrijving", "Aantal", "Prijs", "Totaal (excl. btw)"]
		: ["Description", "Quantity", "Price", "Total (excl. VAT)"];
	heads.forEach((h, i) => {
		para(p1, h, y, { font: fonts.bold, size: 8, width: 120, x: cols[i] });
	});
	y += 16;
	p1.drawLine({
		color: LINE,
		end: { x: A4[0] - 56, y: A4[1] - y },
		start: { x: 56, y: A4[1] - y },
		thickness: 0.6,
	});
	y += 8;
	for (const line of doc.lines ?? []) {
		const top = y;
		y = para(p1, line.description, y, {
			font: fonts.bold,
			size: 9,
			width: 260,
		});
		for (const b of line.bullets)
			y = para(p1, `- ${b}`, y, {
				font: fonts.regular,
				size: 8.5,
				width: 250,
				x: 64,
			});
		para(p1, String(line.quantity), top, {
			font: fonts.regular,
			size: 9,
			width: 60,
			x: cols[1],
		});
		para(p1, money(line.unit_price_cents, doc.currency ?? "EUR"), top, {
			font: fonts.regular,
			size: 9,
			width: 60,
			x: cols[2],
		});
		para(p1, money(line.net_cents, doc.currency ?? "EUR"), top, {
			font: fonts.regular,
			size: 9,
			width: 80,
			x: cols[3],
		});
		y += 10;
	}
	p1.drawLine({
		color: LINE,
		end: { x: A4[0] - 56, y: A4[1] - y },
		start: { x: 56, y: A4[1] - y },
		thickness: 0.6,
	});
	y += 10;
	const cur = doc.currency ?? "EUR";
	for (const [label, cents, bold] of [
		[
			nl ? "Totaal (excl. btw)" : "Total (excl. VAT)",
			doc.subtotal_cents ?? 0,
			false,
		],
		[nl ? "Btw" : "VAT", doc.vat_cents ?? 0, false],
		[
			nl ? "Totaal (incl. btw)" : "Total (incl. VAT)",
			doc.total_cents ?? 0,
			true,
		],
	] as const) {
		para(p1, label, y, {
			font: bold ? fonts.bold : fonts.regular,
			size: 9,
			width: 120,
			x: 330,
		});
		para(p1, money(cents, cur), y, {
			font: bold ? fonts.bold : fonts.regular,
			size: 9,
			width: 80,
			x: cols[3],
		});
		y += 14;
	}
	para(
		p1,
		nl
			? "Met vriendelijke groet, Team dembrane"
			: "Best regards, Team dembrane",
		y + 30,
		{
			font: fonts.regular,
		},
	);

	const p2 = pdf.addPage(A4);
	letterhead(p2, fonts, content?.company ?? DMB);
	let t = 130;
	t = para(p2, nl ? "Acceptatie offerte" : "Offer acceptance", t, {
		font: fonts.bold,
		size: 14,
	});
	para(
		p2,
		nl
			? "Indien je deze offerte wilt accepteren, vul dan onderstaande velden in en onderteken als laatste stap het document."
			: "If you wish to accept this offer, please complete the fields below and sign the document as a final step.",
		t + 6,
		{ font: fonts.regular },
	);
	drawFieldGuides(p2, doc, 2, fonts);
	const legal = content?.legal;
	const items = nl
		? [
				"1. Deze opdrachtbevestiging/offerte;",
				`2. De Algemene Voorwaarden van dembrane B.V. (versie ${legal?.terms.version ?? ""});`,
				`3. Bijlage A: Service Level Agreement (versie ${legal?.sla.version ?? ""}); niet van toepassing bij single events;`,
				`4. Bijlage B: Verwerkersovereenkomst (versie ${legal?.dpa.version ?? ""}).`,
			]
		: [
				"1. This order confirmation/offer;",
				`2. The General Terms and Conditions of dembrane B.V. (version ${legal?.terms.version ?? ""});`,
				`3. Annex A: Service Level Agreement (version ${legal?.sla.version ?? ""}); not for single events;`,
				`4. Annex B: Data Processing Agreement (version ${legal?.dpa.version ?? ""}).`,
			];
	let l = A4[1] * 0.66;
	l = para(
		p2,
		nl
			? "Met de ondertekening van deze offerte verklaart u tevens akkoord te gaan met de volgende documenten, die tezamen de Overeenkomst vormen:"
			: "By signing this offer, you also declare that you have read and agree to the following documents, which together constitute the Agreement:",
		l,
		{ font: fonts.regular, size: 9 },
	);
	for (const item of items)
		l = para(p2, item, l + 2, { font: fonts.regular, size: 9, x: 64 });
	para(
		p2,
		nl
			? "Deze offerte is 14 dagen geldig vanaf de datum van opstellen."
			: "This offer is valid for 14 days starting from the date it was made.",
		l + 14,
		{ color: MUTED, font: fonts.regular, size: 9 },
	);
}

async function textPdf(doc: DocumentDetailT, fonts: Fonts, pdf: PDFDocument) {
	const pages = Math.max(doc.page_count ?? 1, 1);
	for (let n = 1; n <= pages; n++) {
		const page = pdf.addPage(A4);
		letterhead(page, fonts, DMB);
		let y = 130;
		if (n === 1) y = para(page, doc.title, y, { font: fonts.bold, size: 16 });
		else
			y = para(page, `${doc.title} (${n}/${pages})`, y, {
				color: MUTED,
				font: fonts.regular,
				size: 9,
			});
		const body =
			n === 1 && doc.body
				? doc.body
				: `Article ${n}. This page stands in for the published text of the document in the demo. The backend stores and renders the real text, pinned by version and SHA-256.`;
		para(page, body, y + 12, { font: fonts.regular });
		drawFieldGuides(page, doc, n, fonts);
	}
}

async function invoicePdf(
	doc: DocumentDetailT,
	fonts: Fonts,
	pdf: PDFDocument,
) {
	const page = pdf.addPage(A4);
	letterhead(page, fonts, DMB);
	const inv = doc.invoice;
	const cur = doc.currency ?? "EUR";
	let y = 130;
	y = para(page, doc.title, y, { font: fonts.bold, size: 18 });
	y = para(
		page,
		`Issued ${inv?.issued_on ?? ""}, due ${inv?.due_on ?? ""}`,
		y + 4,
		{ color: MUTED, font: fonts.regular, size: 9 },
	);
	y += 20;
	for (const [label, cents] of [
		["Subtotal", doc.subtotal_cents ?? 0],
		["VAT", doc.vat_cents ?? 0],
		["Total", doc.total_cents ?? 0],
	] as const) {
		para(page, label, y, { font: fonts.regular, width: 200 });
		para(page, money(cents, cur), y, {
			font: fonts.regular,
			width: 120,
			x: 400,
		});
		y += 16;
	}
	y += 20;
	y = para(page, "Pay by bank transfer", y, { font: fonts.bold });
	const bt = inv?.bank_transfer;
	for (const line of [
		`IBAN ${bt?.iban ?? ""}`,
		`BIC ${bt?.bic ?? ""}`,
		`In the name of ${bt?.account_name ?? ""}`,
		`Reference ${bt?.reference ?? ""}`,
	]) {
		y = para(page, line, y + 2, { font: fonts.regular });
	}
}

async function fontsOf(pdf: PDFDocument): Promise<Fonts> {
	return {
		bold: await pdf.embedFont(StandardFonts.HelveticaBold),
		italic: await pdf.embedFont(StandardFonts.HelveticaOblique),
		regular: await pdf.embedFont(StandardFonts.Helvetica),
	};
}

/** The unsigned document the viewer renders under the fields. */
export async function renderUnsigned(
	doc: DocumentDetailT,
): Promise<Uint8Array> {
	const pdf = await PDFDocument.create();
	const fonts = await fontsOf(pdf);
	if (doc.kind === "offer") await offerPdf(doc, fonts, pdf);
	else if (doc.kind === "invoice") await invoicePdf(doc, fonts, pdf);
	else await textPdf(doc, fonts, pdf);
	return pdf.save();
}

export async function pageCountOf(bytes: Uint8Array): Promise<number> {
	const pdf = await PDFDocument.load(bytes);
	return pdf.getPageCount();
}

const b64ToBytes = (b64: string): Uint8Array =>
	Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/**
 * The signed PDF: values and signature stamped at their fields, and the audit page the
 * design names (signer, email, organisation, time, hashes, confirmation text).
 */
export async function renderSigned(
	unsigned: Uint8Array,
	doc: DocumentDetailT,
	signaturePng: string | null,
	confirmation: string | null,
): Promise<Uint8Array> {
	const pdf = await PDFDocument.load(unsigned);
	const fonts = await fontsOf(pdf);
	const sig = doc.signature;
	const image = signaturePng
		? await pdf.embedPng(b64ToBytes(signaturePng))
		: null;
	const pages = pdf.getPages();
	for (const f of doc.fields) {
		const page = pages[f.page - 1];
		if (!page) continue;
		const { width: W, height: H } = page.getSize();
		const x = W * f.x;
		const y = H * (1 - f.y - f.height);
		const w = W * f.width;
		const h = H * f.height;
		if (f.kind === "signature" || f.kind === "initials") {
			if (image) {
				const scale = Math.min(w / image.width, h / image.height);
				page.drawImage(image, {
					height: image.height * scale,
					width: image.width * scale,
					x,
					y,
				});
			} else if (sig) {
				page.drawText(safe(sig.name), {
					color: INK,
					font: fonts.italic,
					size: Math.min(h * 0.7, 18),
					x,
					y: y + 4,
				});
			}
			continue;
		}
		const value = sig?.values[f.id];
		if (value === undefined) continue;
		const text = typeof value === "boolean" ? (value ? "X" : "") : value;
		page.drawText(safe(text), {
			color: INK,
			font: fonts.regular,
			size: Math.min(h * 0.75, 10),
			x: x + 2,
			y: y + 3,
		});
	}
	if (sig) {
		const audit = pdf.addPage(A4);
		let y = 60;
		y = para(audit, "Signature record", y, { font: fonts.bold, size: 16 });
		for (const [k, v] of [
			[
				"Document",
				`${doc.title} (${doc.reference ?? ""}), version ${doc.version}`,
			],
			["Signer", `${sig.name}, ${sig.role}`],
			["Email", sig.email],
			["Organisation", sig.organisation],
			["Signed at", sig.signed_at],
			["Method", sig.method],
			["SHA-256 of the unsigned document", sig.sha256],
			["SHA-256 of the signature image", sig.image_sha256],
			["Authorised for data processing", sig.dpa_authorised ? "yes" : "no"],
		]) {
			y = para(audit, k, y + 8, { color: MUTED, font: fonts.regular, size: 8 });
			y = para(audit, v, y, { font: fonts.regular, size: 10 });
		}
		if (confirmation) {
			y = para(audit, "Confirmation", y + 8, {
				color: MUTED,
				font: fonts.regular,
				size: 8,
			});
			para(audit, confirmation, y, { font: fonts.regular, size: 10 });
		}
	}
	return pdf.save();
}
