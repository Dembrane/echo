/**
 * A gettext catalog as lingui writes it, read and written back byte for byte except for
 * the entries a caller changes. Only what lingui emits is supported: one msgid and one
 * msgstr per entry (ICU carries plurals), `#.` extracted comments, `#:` origins, `#,`
 * flags, `# ` translator comments and `#~` obsolete entries.
 */

export interface PoEntry {
  /** The raw lines of the entry, kept so an untouched entry is written back as it was. */
  lines: string[];
  readonly msgid: string;
  readonly msgctxt: string | null;
  msgstr: string;
  readonly flags: ReadonlySet<string>;
  readonly extracted: readonly string[];
  readonly origins: readonly string[];
  readonly obsolete: boolean;
  /** lingui marks entries whose msgid is an explicit id rather than the source text. */
  readonly explicitId: boolean;
}

export interface PoFile {
  /** Blocks in file order: entries, and the header (msgid ""). */
  readonly entries: PoEntry[];
  readonly trailingNewline: boolean;
}

const unescapePo = (s: string) =>
  s.replace(/\\(["\\ntr])/g, (_, c: string) =>
    c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c,
  );

export const escapePo = (s: string) =>
  s
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\t", "\\t")
    .replaceAll("\r", "\\r");

/** The value of a keyword line plus its continuation lines. */
function readValue(lines: string[], start: number, keyword: string): [string, number] {
  const first = lines[start] as string;
  let value = unescapePo(
    first
      .slice(keyword.length + 1)
      .trim()
      .slice(1, -1),
  );
  let i = start + 1;
  while (i < lines.length && (lines[i] as string).startsWith('"')) {
    value += unescapePo((lines[i] as string).slice(1, -1));
    i++;
  }
  return [value, i];
}

function parseEntry(lines: string[]): PoEntry {
  let msgid = "";
  let msgctxt: string | null = null;
  let msgstr = "";
  const flags = new Set<string>();
  const extracted: string[] = [];
  const origins: string[] = [];
  let obsolete = false;
  for (let i = 0; i < lines.length; ) {
    const line = lines[i] as string;
    if (line.startsWith("#~")) {
      obsolete = true;
      i++;
    } else if (line.startsWith("#,")) {
      for (const f of line.slice(2).split(",")) if (f.trim()) flags.add(f.trim());
      i++;
    } else if (line.startsWith("#.")) {
      extracted.push(line.slice(2).trim());
      i++;
    } else if (line.startsWith("#:")) {
      origins.push(...line.slice(2).trim().split(/\s+/));
      i++;
    } else if (line.startsWith("msgctxt ")) {
      [msgctxt, i] = readValue(lines, i, "msgctxt");
    } else if (line.startsWith("msgid ")) {
      [msgid, i] = readValue(lines, i, "msgid");
    } else if (line.startsWith("msgstr ")) {
      [msgstr, i] = readValue(lines, i, "msgstr");
    } else i++;
  }
  return {
    lines,
    msgid,
    msgctxt,
    msgstr,
    flags,
    extracted,
    origins,
    obsolete,
    explicitId: extracted.includes("js-lingui-explicit-id"),
  };
}

export function parsePo(text: string): PoFile {
  const trailingNewline = text.endsWith("\n");
  const blocks = text.replace(/\n+$/, "").split(/\n{2,}/);
  return { entries: blocks.map((b) => parseEntry(b.split("\n"))), trailingNewline };
}

export function serializePo(file: PoFile): string {
  return (
    file.entries.map((e) => e.lines.join("\n")).join("\n\n") + (file.trailingNewline ? "\n" : "")
  );
}

/** The entries a translator still owes: live, with an id, and an empty msgstr. */
export function missingEntries(file: PoFile): PoEntry[] {
  return file.entries.filter((e) => !e.obsolete && e.msgid !== "" && e.msgstr === "");
}

/**
 * Sets an entry's translation and flags it fuzzy: filled by a machine, waiting for a
 * person. lingui keeps the flag through extract and compiles the text as usual, so the
 * screen shows it while the flag tells a reviewer it has not been read.
 */
export function fillEntry(entry: PoEntry, translation: string): void {
  const out: string[] = [];
  let flagged = false;
  let inMsgstr = false;
  for (const line of entry.lines) {
    if (inMsgstr && line.startsWith('"')) continue;
    inMsgstr = false;
    if (line.startsWith("#,")) {
      const flags = line
        .slice(2)
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean);
      if (!flags.includes("fuzzy")) flags.push("fuzzy");
      out.push(`#, ${flags.join(", ")}`);
      flagged = true;
      continue;
    }
    if (!flagged && (line.startsWith("msgctxt ") || line.startsWith("msgid "))) {
      out.push("#, fuzzy");
      flagged = true;
    }
    if (line.startsWith("msgstr ")) {
      out.push(`msgstr "${escapePo(translation)}"`);
      inMsgstr = true;
      continue;
    }
    out.push(line);
  }
  entry.lines = out;
  entry.msgstr = translation;
}
