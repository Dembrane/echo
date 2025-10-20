import { readItem } from "@directus/sdk";
import { useParams } from "react-router";
import useCopyToRichText from "@/hooks/useCopyToRichText";
import { directus } from "@/lib/directus";

export const useCopyQuote = () => {
	const { language, projectId } = useParams<{
		language: string;
		projectId: string;
	}>();
	const { copied, copy } = useCopyToRichText();

	// actually aspect Segment ID
	const copyQuote = async (quoteId: string) => {
		const stringBuilder: string[] = [];

		// @ts-expect-error - Directus SDK has incorrect types for nested fields
		const quote: AspectSegment = await directus.request(
			readItem("aspect_segment", quoteId, {
				fields: [
					"id",
					"description",
					"verbatim_transcript",
					"relevant_index",
					{
						segment: [
							{
								conversation_id: ["id", "participant_name", "created_at"],
							},
						],
					},
				],
			}),
		);

		const conversation = (quote.segment as ConversationSegment)
			?.conversation_id as Conversation;

		// Format timestamp if available
		const timestamp = conversation?.created_at ?? "";

		// // Format tags if available
		// const tags = ((quote.segment as ConversationSegment)?.conversation_id as Conversation)?.tags
		//   ?.map(
		//     (tag: ConversationProjectTag) =>
		//       tag.project_tag_id?.text ?? "",
		//   )
		//   .join(", ");

		// Build the formatted quote with context
		stringBuilder.push(
			`# Quote from [${conversation?.participant_name}](${window.location.origin}/${language}/projects/${projectId}/conversation/${conversation?.id}/transcript)`,
		);
		stringBuilder.push(`"${quote.description}"`);
		stringBuilder.push(`${quote.verbatim_transcript}`);

		try {
			const startIndex = Number.parseInt(
				quote.relevant_index?.split(":")[0] ?? "0",
				10,
			);
			const endIndex = Number.parseInt(
				quote.relevant_index?.split(":")[1] ?? "0",
				10,
			);

			const relevantTranscript = quote.verbatim_transcript?.slice(
				startIndex,
				endIndex,
			);

			if (relevantTranscript) {
				stringBuilder.push(`${relevantTranscript}`);
			}
		} catch (e) {
			console.error(e);
		}

		stringBuilder.push("---");

		stringBuilder.push(""); // Empty line for spacing

		// Add metadata
		if (conversation?.participant_name) {
			stringBuilder.push(`**Conversation:** ${conversation.participant_name}`);
		}

		if (timestamp) {
			stringBuilder.push(`${timestamp}`);
			stringBuilder.push("");
		}

		// if (tags) {
		//   stringBuilder.push(`**Tags:** ${tags}`);
		//   stringBuilder.push("");
		// }

		// Add source link
		const sourceUrl = `${window.location.origin}/${language}/projects/${projectId}/conversation/${conversation?.id}/transcript`;
		stringBuilder.push(""); // Empty line before source
		stringBuilder.push(`[View in conversation](${sourceUrl})`);

		copy(stringBuilder.join("\n"));
	};

	return {
		copied,
		copyQuote,
	};
};
