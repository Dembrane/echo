import { Anchor, Group } from "@mantine/core";
import { useParams } from "react-router";
import { I18nLink } from "@/components/common/i18nLink";

export const ConversationLinks = ({
	conversations,
	color,
	hoverUnderlineColor,
}: {
	conversations: Conversation[];
	color?: string;
	hoverUnderlineColor?: string;
}) => {
	const { projectId } = useParams();

	// an error could occur if the conversation is deleted and not filtered in ChatHistoryMessage.tsx
	return (
		<Group gap="xs" align="center">
			{conversations?.map((conversation) => (
				<I18nLink
					key={conversation.id}
					to={`/projects/${projectId}/conversation/${conversation.id}/overview`}
				>
					<Anchor
						size="xs"
						c={color}
						underline="never"
						styles={
							hoverUnderlineColor
								? {
										root: {
											"&:hover": {
												textDecoration: "underline",
												textDecorationColor: hoverUnderlineColor,
											},
										},
									}
								: undefined
						}
					>
						{conversation.participant_name}
					</Anchor>
				</I18nLink>
			)) ?? null}
		</Group>
	);
};
