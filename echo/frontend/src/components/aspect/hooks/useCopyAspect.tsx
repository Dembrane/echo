import { readItem } from "@directus/sdk";
import { useParams } from "react-router";
import useCopyToRichText from "@/hooks/useCopyToRichText";
import { directus } from "@/lib/directus";

export const useCopyAspect = () => {
	const { language, projectId } = useParams();
	const { copied, copy } = useCopyToRichText();

	const copyAspect = async (aspectId: string) => {
		const stringBuilder: string[] = [];
		const aspect = await directus.request(
			readItem("aspect", aspectId, {
				fields: [
					"id",
					"name",
					"short_summary",
					"long_summary",
					"image_url",
					"view_id",
					{
						aspect_segment: [
							{
								segment: [
									{
										conversation_id: ["id", "participant_name"],
									},
									"description",
									"verbatim_transcript",
									"relevant_index",
								],
							},
						],
					},
				],
			}),
		);

		stringBuilder.push(
			`# Aspect: [${aspect.name}](${window.location.origin}/${language}/projects/${projectId}/library/views/${aspect.view_id}/aspects/${aspectId})`,
		);

		if (aspect.image_url) {
			stringBuilder.push(`![${aspect.name}](${aspect.image_url})`);
		}

		if (aspect.long_summary) {
			stringBuilder.push(aspect.long_summary);
		} else if (aspect.short_summary) {
			stringBuilder.push(aspect.short_summary);
		} else {
			stringBuilder.push(
				"The summary for this aspect is not available. Please try again later.",
			);
		}

		const quotes = Array.isArray(aspect.aspect_segment)
			? (aspect.aspect_segment as AspectSegment[])
			: [];
		if (quotes.length > 0) {
			stringBuilder.push("## Top Quotes");

			for (const quote of quotes) {
				if (!quote.segment) continue;

				const conversationId = (quote.segment as ConversationSegment)
					.conversation_id as string;
				const description = quote.description ?? "No description available";
				const conversation = (quote.segment as ConversationSegment)
					?.conversation_id as Conversation;
				const participantName = conversation?.participant_name ?? "Unknown";

				const conversationUrl =
					window.location.origin +
					`/${language}/projects/${projectId}/conversation/${conversationId}/transcript`;

				stringBuilder.push(`"${description}"\n`);
				stringBuilder.push(`from [${participantName}](${conversationUrl})\n\n`);
			}
		}

		copy(stringBuilder.join("\n"));
	};

	return {
		copied,
		copyAspect,
	};
};
