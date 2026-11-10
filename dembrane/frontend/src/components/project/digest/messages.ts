import { t } from "@lingui/core/macro";
import type { FileRefusal } from "./limits";
import { MAX_FILES } from "./limits";

/** Why one file was not read, and what to do instead. */
export function refusalMessage(reason: FileRefusal): string {
	switch (reason) {
		case "too_many":
			return t`Not read: dembrane reads up to ${MAX_FILES} files at a time.`;
		case "too_large":
			return t`Larger than 10 MB. Try a shorter version, or paste the part that matters.`;
		case "legacy_format":
			return t`This older format can't be read here. Save it as PDF, .docx or .pptx and drop it again.`;
		case "spreadsheet":
			return t`Spreadsheets aren't read. PDF, Word, PowerPoint and text files work.`;
		case "image":
			return t`Pictures aren't read. PDF, Word, PowerPoint and text files work.`;
		case "unsupported":
			return t`This kind of file can't be read. PDF, Word (.docx), PowerPoint (.pptx) and text files work.`;
		case "scanned_pdf":
			return t`This PDF is a scan, so there is no text to read. Paste the text, or drop a version you can select text in.`;
		case "empty":
			return t`There is no text in this file.`;
		case "unreadable":
			return t`This file couldn't be opened. It may be damaged or protected with a password.`;
		case "over_total":
			return t`Not read: together the files are longer than 200,000 characters.`;
	}
}
