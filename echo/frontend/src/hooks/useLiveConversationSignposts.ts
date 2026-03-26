import { readItems } from "@directus/sdk";
import { useQuery } from "@tanstack/react-query";
import { directus } from "@/lib/directus";

export type LiveConversationSignpost = Pick<
	ConversationSignpost,
	| "id"
	| "category"
	| "title"
	| "summary"
	| "evidence_quote"
	| "confidence"
	| "updated_at"
> & {
	conversation_id: string | null;
};

const POLL_INTERVAL = 15000;

export const useLiveConversationSignposts = (
	conversationIds: string[],
	enabled: boolean,
) => {
	const sortedConversationIds = [...conversationIds].sort();

	const query = useQuery({
		enabled: enabled && sortedConversationIds.length > 0,
		queryFn: async () => {
			const result = await directus.request(
				readItems("conversation_signpost", {
					fields: [
						"id",
						"conversation_id",
						"category",
						"title",
						"summary",
						"evidence_quote",
						"confidence",
						"updated_at",
					],
					filter: {
						conversation_id: {
							_in: sortedConversationIds,
						},
						status: {
							_eq: "active",
						},
					},
					limit: Math.max(sortedConversationIds.length * 12, 24),
					sort: ["-updated_at"],
				}),
			);

			return result as LiveConversationSignpost[];
		},
		queryKey: ["live-conversation-signposts", sortedConversationIds.join(",")],
		refetchInterval: enabled ? POLL_INTERVAL : false,
	});

	const signposts = query.data ?? [];
	const signpostsByConversation = signposts.reduce<
		Record<string, LiveConversationSignpost[]>
	>((acc, signpost) => {
		if (!signpost.conversation_id) {
			return acc;
		}

		acc[signpost.conversation_id] = acc[signpost.conversation_id] ?? [];
		acc[signpost.conversation_id].push(signpost);
		return acc;
	}, {});

	return {
		...query,
		signposts,
		signpostsByConversation,
	};
};
