/**
 * Reading Office Open XML without a parser: a run of tags and text, enough to take the
 * text of paragraphs in document order. Works the same in the browser and in tests.
 */

const ENTITIES: Record<string, string> = {
	amp: "&",
	apos: "'",
	gt: ">",
	lt: "<",
	quot: '"',
};

export function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
		if (code[0] === "#") {
			const n =
				code[1] === "x" || code[1] === "X"
					? Number.parseInt(code.slice(2), 16)
					: Number.parseInt(code.slice(1), 10);
			return Number.isFinite(n) && n > 0 && n <= 0x10ffff
				? String.fromCodePoint(n)
				: "";
		}
		return ENTITIES[code.toLowerCase()] ?? whole;
	});
}

export type XmlToken =
	| { type: "open"; name: string; attrs: string; selfClosing: boolean }
	| { type: "close"; name: string }
	| { type: "text"; text: string };

/** The tags and text of an XML document, comments, declarations and CDATA left out. */
export function* tokens(xml: string): Generator<XmlToken> {
	const re =
		/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([\w:.-]+)([^>]*?)(\/?)>|([^<]+)/g;
	for (const m of xml.matchAll(re)) {
		if (m[1] !== undefined) yield { text: m[1], type: "text" };
		else if (m[3] !== undefined) {
			if (m[2] === "/") yield { name: m[3], type: "close" };
			else
				yield {
					attrs: m[4] ?? "",
					name: m[3],
					selfClosing: m[5] === "/",
					type: "open",
				};
		} else if (m[6] !== undefined)
			yield { text: decodeEntities(m[6]), type: "text" };
	}
}

export interface ParagraphRules {
	/** The paragraph element: "w:p" in Word, "a:p" in slides. */
	paragraph: string;
	/** Elements whose text is kept: "w:t", "a:t". */
	text: readonly string[];
	/** Empty elements that stand for a tab or a line break. */
	tab?: readonly string[];
	breaks?: readonly string[];
	/** Elements whose whole content is skipped: deleted text, fields, fallbacks. */
	skip?: readonly string[];
}

/** The text of every paragraph, in document order, one per line; empty ones left out. */
export function paragraphs(xml: string, rules: ParagraphRules): string[] {
	const out: string[] = [];
	let current = "";
	let inText = 0;
	let skipping = 0;
	for (const t of tokens(xml)) {
		if (t.type === "open") {
			if (rules.skip?.includes(t.name)) {
				if (!t.selfClosing) skipping++;
				continue;
			}
			if (skipping) continue;
			if (rules.text.includes(t.name) && !t.selfClosing) inText++;
			else if (rules.tab?.includes(t.name)) current += "\t";
			else if (rules.breaks?.includes(t.name)) current += "\n";
		} else if (t.type === "close") {
			if (rules.skip?.includes(t.name)) {
				skipping = Math.max(0, skipping - 1);
				continue;
			}
			if (skipping) continue;
			if (rules.text.includes(t.name)) inText = Math.max(0, inText - 1);
			else if (t.name === rules.paragraph) {
				const line = current.replace(/[ \t ]+/g, " ").trim();
				if (line) out.push(line);
				current = "";
			}
		} else if (inText && !skipping) current += t.text;
	}
	const tail = current.trim();
	if (tail) out.push(tail);
	return out;
}

/** The value of one attribute in a tag's attribute text. */
export const attr = (attrs: string, name: string): string | null => {
	const m = new RegExp(
		`(?:^|\\s)${name.replace(/[.*+?^${}()|[\]\\:]/g, "\\$&")}="([^"]*)"`,
	).exec(attrs);
	return m ? decodeEntities(m[1] as string) : null;
};
