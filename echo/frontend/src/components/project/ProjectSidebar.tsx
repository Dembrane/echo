import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Icons } from "@/icons";
import { useCreateChatMutation, useProjectById } from "@/lib/query";
import {
  ActionIcon,
  Box,
  Group,
  LoadingOverlay,
  Stack,
  Title,
  Tooltip,
} from "@mantine/core";
import { useLocation, useParams } from "react-router-dom";
import { ProjectAccordion } from "./ProjectAccordion";
import { NavigationButton } from "../common/NavigationButton";
import { Breadcrumbs } from "../common/Breadcrumbs";
import { ProjectQRCode } from "./ProjectQRCode";
import { I18nLink } from "../common/i18nLink";
import { ReportModalNavigationButton } from "../report/ReportModalNavigationButton";
import { LogoDembrane } from "../common/Logo";

export const ProjectSidebar = () => {
  const { projectId, conversationId } = useParams();

  const projectQuery = useProjectById({ projectId: projectId ?? "" });
  const { pathname } = useLocation();

  // const { isCollapsed, toggleSidebar } = useSidebarCollapsed();

  const createChatMutation = useCreateChatMutation();

  const handleAsk = () => {
    createChatMutation.mutate({
      project_id: { id: projectId ?? "" },
      conversationId: conversationId ?? "",
      navigateToNewChat: true,
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
              link: `/projects`,
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

      <Box hiddenFrom="lg">
        <ProjectQRCode project={projectQuery.data} />
      </Box>

      <ProjectAccordion projectId={projectId} />

      <Stack className="text-center">
        <Group
          component="a"
          // @ts-ignore
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
