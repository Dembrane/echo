import { Trans } from "@lingui/react/macro";
import { Badge, Box, Group, Text } from "@mantine/core";
import { useParams } from "react-router";
import { I18nLink } from "@/components/common/i18nLink";
import {
	conversationReferencePath,
	getChunkIdFromReference,
} from "./conversationReferenceLinks";

export const Sources = ({
	metadata,
	projectId,
}: {
	// biome-ignore lint/suspicious/noExplicitAny: needs to be fixed
	metadata: any[];
	projectId: string | undefined;
}) => {
	const { workspaceId } = useParams();
	const references = metadata.filter((m) => m.type === "reference");

	if (references.length === 0) return null;

	return (
		<Box
			className="prose prose-sm flex flex-col border-x-0 border-y border-solid py-4"
			style={{ borderColor: "var(--app-rule-color)" }}
		>
			<Group gap="sm" align="center">
				<Text size="sm">
					<Trans>
						The following conversations were automatically added to the context
					</Trans>
				</Text>
			</Group>
			<Group gap="xs" mt="sm">
				{references.map((ref, index) => {
					const conversationId = ref?.conversation?.id || ref?.conversation;
					if (!workspaceId || !projectId || !conversationId) return null;
					return (
						<Badge
							component={I18nLink}
							// biome-ignore lint/suspicious/noArrayIndexKey: needs to be fixed
							key={index}
							to={conversationReferencePath({
								chunkId: getChunkIdFromReference(ref),
								conversationId,
								projectId,
								workspaceId,
							})}
							color="gray"
						>
							{ref?.conversation_title ||
								ref?.conversation?.participant_name || (
									<Trans>Source {index + 1}</Trans>
								)}
						</Badge>
					);
				})}
			</Group>
		</Box>
	);
};
