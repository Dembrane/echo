import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Box,
	Group,
	LoadingOverlay,
	Stack,
	Title,
	Tooltip,
} from "@mantine/core";
import { GraphIcon, HouseIcon, QuestionIcon } from "@phosphor-icons/react";
import { useRef } from "react";
import { useLocation, useParams } from "react-router";
import { useInitializeChatModeMutation } from "@/components/chat/hooks";
import { useProjectById } from "@/components/project/hooks";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";

import { Breadcrumbs } from "../common/Breadcrumbs";
import { I18nLink } from "../common/i18nLink";
import { LogoDembrane } from "../common/Logo";
import { NavigationButton } from "../common/NavigationButton";
import { ReportModalNavigationButton } from "../report/ReportModalNavigationButton";
import { useCreateChatMutation } from "./hooks";
import { ProjectAccordion } from "./ProjectAccordion";
import { ProjectQRCode } from "./ProjectQRCode";

export const ProjectSidebar = () => {
	const { projectId, conversationId } = useParams();
	const qrCodeRef = useRef<HTMLDivElement>(null);
	const navigate = useI18nNavigate();

	const projectQuery = useProjectById({
		projectId: projectId ?? "",
		query: {
			fields: [
				"id",
				"name",
				"language",
				"is_conversation_allowed",
				"default_conversation_title",
			],
		},
	});
	const { pathname } = useLocation();

	// const { isCollapsed, toggleSidebar } = useSidebarCollapsed();

	const createChatMutation = useCreateChatMutation();
	const initializeModeMutation = useInitializeChatModeMutation();

	const handleAsk = async () => {
		if (conversationId) {
			// When clicking Ask from a conversation, create chat and go to deep_dive mode
			try {
				const chat = await createChatMutation.mutateAsync({
					conversationId: conversationId,
					navigateToNewChat: false,
					project_id: { id: projectId ?? "" },
				});

				if (chat?.id) {
					// Initialize deep_dive mode
					await initializeModeMutation.mutateAsync({
						chatId: chat.id,
						mode: "deep_dive",
						projectId: projectId ?? "",
					});
					navigate(`/projects/${projectId}/chats/${chat.id}`);
				}
			} catch (error) {
				console.error("Failed to create chat:", error);
			}
		} else {
			// Otherwise, navigate to mode selection
			navigate(`/projects/${projectId}/chats/new`);
		}
	};

	if (!projectId) {
		return null;
	}

	return (
		<Stack className="h-full w-full px-4 py-6">
			<LoadingOverlay visible={projectQuery.isLoading} />
			<Group justify="space-between">
				<Breadcrumbs
					items={[
						{
							label: (
								<Tooltip label={t`Projects Home`}>
									<ActionIcon variant="transparent">
										<HouseIcon size={28} color="var(--app-text)" />
									</ActionIcon>
								</Tooltip>
							),
							link: "/projects",
						},
						{
							label: (
								<I18nLink to={`/projects/${projectId}/portal-editor`}>
									<Title
										component="span"
										order={2}
										size="lg"
										className="whitespace-break-spaces hover:underline"
									>
										{projectQuery.data?.name}
									</Title>
								</I18nLink>
							),
						},
					]}
				/>
				{/* 
        <Tooltip label={t`Project Overview`}>
          <I18nLink to={`/projects/${projectId}/overview`}>
            <ActionIcon
              component="a"
              variant="transparent"
              aria-label={t`Project Overview and Edit`}
            >
              <Icons.Gear color="var(--app-text)" />
            </ActionIcon>
          </I18nLink>
        </Tooltip> */}
				{/* 
        {!isCollapsed && (
          <ActionIcon variant="transparent" onClick={toggleSidebar}>
            <Icons.Sidebar />
          </ActionIcon>
        )} */}
			</Group>

			<NavigationButton
				onClick={handleAsk}
				component="button"
				rightIcon={<QuestionIcon size={24} color="var(--app-text)" />}
				active={pathname.includes("chat")}
			>
				<Trans>Ask</Trans>
			</NavigationButton>

			<NavigationButton
				to={`/projects/${projectId}/library`}
				component="a"
				rightIcon={<GraphIcon size={24} color="var(--app-text)" />}
				active={pathname.includes("library")}
			>
				<Trans>Library</Trans>
			</NavigationButton>

			<ReportModalNavigationButton />

			<Box hiddenFrom="lg" ref={qrCodeRef}>
				<ProjectQRCode project={projectQuery.data} />
			</Box>

			<ProjectAccordion projectId={projectId} qrCodeRef={qrCodeRef} />

			<Stack className="text-center md:pb-10">
				<Group
					component="a"
					// @ts-expect-error
					href="https://dembrane.com"
					target="_blank"
					align="center"
					justify="center"
					gap="md"
				>
					<div className="text-xs">
						<Trans>Powered by</Trans>
					</div>
					<LogoDembrane />
				</Group>
			</Stack>
		</Stack>
	);
};
