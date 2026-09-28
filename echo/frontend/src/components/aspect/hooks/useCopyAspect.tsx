import { useParams } from "react-router";
import useCopyToRichText from "@/hooks/useCopyToRichText";
import { bff } from "@/lib/bff";

export const useCopyAspect = () => {
	const { language, workspaceId, projectId } = useParams();
	const { copied, copy } = useCopyToRichText();

	const copyAspect = (aspectId: string) => {
		const fetchAndFormat = async () => {
			const stringBuilder: string[] = [];
			const aspect = await bff.get<Aspect>(`/aspects/${aspectId}`);

			stringBuilder.push(
				`# Aspect: [${aspect.name}](${window.location.origin}/${language}/w/${workspaceId}/projects/${projectId}/library/views/${aspect.view_id}/aspects/${aspectId})`,
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

					const conversation = (quote.segment as ConversationSegment)
						?.conversation_id as Conversation;
					const conversationId = conversation?.id;
					const description = quote.description ?? "No description available";
					const participantName = conversation?.participant_name ?? "Unknown";

					const conversationUrl =
						window.location.origin +
						`/${language}/w/${workspaceId}/projects/${projectId}/conversations/${conversationId}`;

					stringBuilder.push(`"${description}"\n`);
					stringBuilder.push(
						`from [${participantName}](${conversationUrl})\n\n`,
					);
				}
			}

			return stringBuilder.join("\n");
		};

		copy(fetchAndFormat());
	};

	return {
		copied,
		copyAspect,
	};
};
