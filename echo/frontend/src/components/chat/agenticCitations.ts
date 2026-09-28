/**
 * Conversation citations as popovers instead of a sources list.
 *
 * The agent cites with markdown footnotes: `[^1]` inline, and at the end a
 * definition `[^1]: [conversation_id:<id>;chunk_id:<id>] <why this source>`.
 * Definitions that carry a conversation tag are taken out of the text, and each
 * inline marker becomes a link whose href carries what the popover shows. The
 * `a` renderer in ChatHistoryMessage turns that link into the popover. A
 * footnote without a conversation tag (a docs citation) is left as markdown.
 */

export const CITATION_HREF_PREFIX = "#agentic-cite:";

export type CitationData = {
	/** Transcript link, deep-linked to the chunk when there is one. */
	href: string;
	/** Who the conversation is with, when known. */
	name: string | null;
	/** The agent's one line on why it cited this. */
	reason: string | null;
};

const DEFINITION_PATTERN = /^\s*\[\^([^\]\s]+)\]:\s*(.*)$/;
const TAG_PATTERN = /\[conversation_id:([^;\]\s]+)(?:;chunk_id:([^\]\s]+))?\]/;
// A footnote marker that is not itself a definition.
const MARKER_PATTERN = /\[\^([^\]\s]+)\](?!:)/g;
const LEADING_SEPARATORS = /^[\s\-–—:,.;|]+/;

const encodeData = (data: CitationData) =>
	encodeURIComponent(JSON.stringify(data)).replace(
		/[()]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);

export const decodeCitationHref = (
	href: string | undefined,
): CitationData | null => {
	if (!href?.startsWith(CITATION_HREF_PREFIX)) return null;
	try {
		const parsed = JSON.parse(
			decodeURIComponent(href.slice(CITATION_HREF_PREFIX.length)),
		) as Partial<CitationData>;
		if (typeof parsed.href !== "string") return null;
		return {
			href: parsed.href,
			name: typeof parsed.name === "string" ? parsed.name : null,
			reason: typeof parsed.reason === "string" ? parsed.reason : null,
		};
	} catch {
		return null;
	}
};

export const citationsToPopoverLinks = (
	content: string,
	resolve: (
		conversationId: string,
		chunkId: string | undefined,
	) => { href: string; name: string | null },
): string => {
	const citations = new Map<string, CitationData>();
	const kept: string[] = [];

	for (const line of content.split("\n")) {
		const definition = line.match(DEFINITION_PATTERN);
		const tag = definition?.[2].match(TAG_PATTERN);
		if (!definition || !tag) {
			kept.push(line);
			continue;
		}
		const [, conversationId, chunkId] = tag;
		const reason = definition[2]
			.replace(TAG_PATTERN, "")
			.replace(LEADING_SEPARATORS, "")
			.trim();
		const { href, name } = resolve(conversationId.trim(), chunkId?.trim());
		citations.set(definition[1], { href, name, reason: reason || null });
	}

	if (citations.size === 0) return content;

	return kept
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trimEnd()
		.replace(MARKER_PATTERN, (marker, id: string) => {
			const data = citations.get(id);
			return data
				? `[${id}](${CITATION_HREF_PREFIX}${encodeData(data)})`
				: marker;
		});
};
