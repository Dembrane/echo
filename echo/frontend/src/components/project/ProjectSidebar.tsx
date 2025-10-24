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
import { useRef } from "react";
import { useLocation, useParams } from "react-router";
import { useProjectById } from "@/components/project/hooks";
import { Icons } from "@/icons";
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

	const handleAsk = () => {
		createChatMutation.mutate({
			conversationId: conversationId,
			navigateToNewChat: true,
			project_id: { id: projectId ?? "" },
		});
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
										<Icons.Home color="black" />
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
              <Icons.Gear color="black" />
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
				rightIcon={<Icons.Stars />}
				active={pathname.includes("chat")}
			>
				<Trans>Ask</Trans>
			</NavigationButton>

			<NavigationButton
				to={`/projects/${projectId}/library`}
				component="a"
				rightIcon={<Icons.LightBulb />}
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
