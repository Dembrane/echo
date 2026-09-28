import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, Group, Text } from "@mantine/core";
import { IconArrowRight } from "@tabler/icons-react";
import { useParams } from "react-router";
import { SuggestionCardFrame } from "@/components/common/SuggestionCardFrame";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { testId } from "@/lib/testUtils";

export type NavigationPageKey =
	| "overview"
	| "chats"
	| "monitor"
	| "library"
	| "host-guide"
	| "report"
	| "conversations"
	| "settings"
	| "portal-editor";

export type NavigationSuggestion = {
	projectId: string;
	page: NavigationPageKey;
	entityId?: string | null;
};

type NavigationTarget = {
	label: string;
	buttonLabel: string;
	buildPath: (context: {
		entityId?: string | null;
		projectId: string;
		workspaceId: string;
	}) => string;
};

const projectPath = ({
	projectId,
	workspaceId,
}: {
	projectId: string;
	workspaceId: string;
}) => `/w/${workspaceId}/projects/${projectId}`;

const NAVIGATION_TARGETS: Record<NavigationPageKey, NavigationTarget> = {
	chats: {
		buildPath: (context) => `${projectPath(context)}/chats/new`,
		buttonLabel: t`Go to chats`,
		label: t`project chats`,
	},
	conversations: {
		buildPath: (context) =>
			context.entityId
				? `${projectPath(context)}/conversations/${encodeURIComponent(context.entityId)}`
				: `${projectPath(context)}/conversations`,
		buttonLabel: t`Go to conversations`,
		label: t`conversations`,
	},
	"host-guide": {
		buildPath: (context) => `${projectPath(context)}/host-guide`,
		buttonLabel: t`Go to host guide`,
		label: t`host guide`,
	},
	library: {
		buildPath: (context) =>
			context.entityId
				? `${projectPath(context)}/canvases/${encodeURIComponent(context.entityId)}`
				: `${projectPath(context)}/library`,
		buttonLabel: t`Go to library`,
		label: t`library`,
	},
	monitor: {
		buildPath: (context) => `${projectPath(context)}/monitor`,
		buttonLabel: t`Go to monitor`,
		label: t`live monitor`,
	},
	overview: {
		buildPath: (context) => `${projectPath(context)}/home`,
		buttonLabel: t`Go to overview`,
		label: t`project overview`,
	},
	"portal-editor": {
		buildPath: (context) => `${projectPath(context)}/portal-editor`,
		buttonLabel: t`Go to portal editor`,
		label: t`portal editor`,
	},
	report: {
		buildPath: (context) => `${projectPath(context)}/report`,
		buttonLabel: t`Go to report`,
		label: t`report`,
	},
	settings: {
		buildPath: (context) => `${projectPath(context)}/overview`,
		buttonLabel: t`Go to settings`,
		label: t`project settings`,
	},
};

export const NavigationSuggestionCard = ({
	suggestion,
}: {
	suggestion: NavigationSuggestion;
}) => {
	const { workspaceId } = useParams<{ workspaceId: string }>();
	const navigate = useI18nNavigate();
	const target = NAVIGATION_TARGETS[suggestion.page];

	if (!workspaceId || !suggestion.projectId || !target) return null;

	const path = target.buildPath({
		entityId: suggestion.entityId,
		projectId: suggestion.projectId,
		workspaceId,
	});

	return (
		<SuggestionCardFrame compact testId="agentic-navigation-suggestion">
			<Group gap="sm" justify="space-between" wrap="nowrap">
				<Text size="sm" className="min-w-0 flex-1">
					<Trans>Open the {target.label} from here.</Trans>
				</Text>
				<Button
					size="xs"
					rightSection={<IconArrowRight size={14} />}
					onClick={() => navigate(path)}
					{...testId("navigation-suggestion-button")}
				>
					{target.buttonLabel}
				</Button>
			</Group>
		</SuggestionCardFrame>
	);
};
