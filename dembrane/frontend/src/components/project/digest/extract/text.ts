/**
 * Plain text and Markdown files: decoded as UTF-8 (UTF-16 when the file starts with its
 * byte order mark), and as Windows-1252 when the bytes are not valid UTF-8, which is what
 * older Windows tools save.
 */
export function plainText(bytes: Uint8Array): string {
	if (bytes[0] === 0xff && bytes[1] === 0xfe)
		return new TextDecoder("utf-16le").decode(bytes.subarray(2));
	if (bytes[0] === 0xfe && bytes[1] === 0xff)
		return new TextDecoder("utf-16be").decode(bytes.subarray(2));
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
			bytes,
		);
	} catch {
		return new TextDecoder("windows-1252").decode(bytes);
	}
}

/** Text as the digest reads it: one kind of line break, no trailing spaces, no runs of blank lines. */
export function tidyText(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.split(String.fromCharCode(0))
		.join("")
		.split("\n")
		.map((l) => l.replace(/[ \t ]+$/g, ""))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
