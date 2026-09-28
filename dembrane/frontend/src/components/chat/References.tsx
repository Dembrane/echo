import { Trans } from "@lingui/react/macro";
import { Badge, Box, Text } from "@mantine/core";
import posthog from "posthog-js";
import { useParams } from "react-router";
import { I18nLink } from "@/components/common/i18nLink";
import {
	conversationReferencePath,
	getChunkIdFromReference,
} from "./conversationReferenceLinks";

export const References = ({
	metadata,
	projectId,
}: {
	// biome-ignore lint/suspicious/noExplicitAny: needs to be fixed
	metadata: any[];
	projectId: string | undefined;
}) => {
	const { workspaceId } = useParams();
	const citations = metadata.filter((m) => m.type === "citation");

	if (citations.length === 0) return null;

	return (
		<Box className="prose prose-sm flex flex-col">
			<Text component="h3" size="lg" my={0}>
				<Trans>References</Trans>
			</Text>

			<ul className="list-disc space-y-1 pl-5 text-gray-700 [&>li::marker]:text-gray-300">
				{citations.map((citation, index) => {
					const conversationId =
						citation?.conversation?.id || citation?.conversation;
					if (!workspaceId || !projectId || !conversationId) return null;
					const chunkId = getChunkIdFromReference(citation);
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: needs to be fixed
						<li key={index}>
							<Text size="sm" className="leading-relaxed" my={10}>
								<span className="mr-2">
									<Trans>{citation.reference_text}</Trans>
								</span>
								<I18nLink
									to={conversationReferencePath({
										chunkId,
										conversationId,
										projectId,
										workspaceId,
									})}
									onClick={() => {
										posthog.capture("chat_citation_clicked", {
											chunk_id: chunkId,
											conversation_id: conversationId,
											project_id: projectId,
										});
									}}
								>
									<Badge
										size="sm"
										variant="light"
										color="gray"
										className="cursor-pointer transition-colors hover:bg-gray-200"
									>
										<Text
											size="xs"
											className="normal-case leading-relaxed text-gray-700"
										>
											{citation?.conversation_title ||
												citation?.conversation?.participant_name || (
													<Trans>Untitled Conversation</Trans>
												)}
										</Text>
									</Badge>
								</I18nLink>
							</Text>
						</li>
					);
				})}
			</ul>
		</Box>
	);
};
